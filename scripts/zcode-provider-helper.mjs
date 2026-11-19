#!/usr/bin/env bun
// Uses the installed ZCode provider codec/registry; never duplicates its schema.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Ordered vocabulary shared with botmux's control plane. `disabled`/`enabled`
// are toggle-style levels some models declare instead of a graded ladder.
const EFFORT_RANK={none:0,off:0,disabled:0,minimal:1,low:1,medium:2,enabled:3,high:3,xhigh:4,max:5,ultra:6};
/** Closest supported level to the requested one: prefer the highest level at or
 *  below the request (max -> xhigh -> high), and never silently cross to another
 *  model. Returns the model's own highest level when the request is unranked. */
function closestLevel(values,requested){
  if(!Array.isArray(values)||values.length===0) return undefined;
  if(values.includes(requested)) return {level:requested,adjusted:false};
  const rank=(v)=>EFFORT_RANK[v];
  const req=rank(requested);
  const off=values.filter(v=>rank(v)===0);
  const real=values.filter(v=>(rank(v)??0)>0);
  if(req===undefined) return {level:values.at(-1),adjusted:true};
  if(req===0) return {level:off[0]??real[0],adjusted:true};
  const pool=real.length?real:values;
  const below=pool.filter(v=>(rank(v)??99)<=req);
  if(below.length) return {level:below.reduce((a,b)=>((rank(b)??0)>(rank(a)??0)?b:a)),adjusted:true};
  return {level:pool.reduce((a,b)=>((rank(b)??99)<(rank(a)??99)?b:a)),adjusted:true};
}


// ── Reasoning-dialect guard ──────────────────────────────────────────────────
// ZCode's catch-all model rule maps one reasoning level onto EVERY dialect at
// once (`thinking` + `enable_thinking` + `reasoning_effort` + `reasoning.effort`).
// Tolerant gateways ignore the extras, but some providers stall on the
// contradictory combination until their gateway timeout drops the socket, and
// ZCode then retries the whole conversation. Picking the dialect by hand for
// every new model is not acceptable, so the level is mapped to exactly one
// dialect here, chosen from the provider's protocol / gateway / model family.
const DIALECT_NAMES=['thinking','enable_thinking','reasoning_effort','reasoning'];
const OFF_LEVELS='reasoningLevel == "disabled" || reasoningLevel == "none" || reasoningLevel == "off"';
function dialectMap(kind){
  if(kind==='responses') return '{"reasoning": {"effort": reasoningLevel}}';
  if(kind==='thinking') return `{"thinking": {"type": ${OFF_LEVELS} ? "disabled" : "enabled"}}`;
  if(kind==='enable_thinking') return `{"enable_thinking": !(${OFF_LEVELS})}`;
  return '{"reasoning_effort": reasoningLevel}';
}
function dialectKind(provider,modelId){
  const apiType=String(provider?.config?.api?.type??'').toLowerCase();
  if(apiType.includes('responses')) return 'responses';
  const host=String(provider?.config?.api?.baseUrl??'').toLowerCase();
  const id=String(modelId??'').toLowerCase();
  if(/xiaomimimo|mimo/.test(host)||/^mimo/.test(id)) return 'thinking';
  if(/bigmodel|zhipu|glm/.test(host)||/^glm/.test(id)) return 'thinking';
  if(/dashscope|qianwenai|aliyuncs/.test(host)||/^qwen/.test(id)) return 'enable_thinking';
  return 'reasoning_effort';
}
/** How many dialects a map string tries to set at once. */
function dialectCount(mapText){
  const value=String(mapText??'');
  return DIALECT_NAMES.filter(name=>value.includes(`"${name}"`)).length;
}
/** Rewrite the RAW personal config so every model that offers a reasoning level
 *  sends exactly one dialect. Works on plain JSON on purpose: the decoded
 *  registry objects are class instances that cannot be round-tripped.
 *  Curated single-dialect maps are left exactly as they are. */
function tuneDialects(config,effective){
  const root=config?.config;
  const providers=new Map((root?.providerConfigRules?.providerRules??[]).map(p=>[p.providerId,p]));
  const rules=root?.modelConfigRules?.providerModelRules??[];
  const index=new Map(rules.map(r=>[`${r.providerId}\u0000${r.modelId}`,r]));
  const changed=[];
  for(const [key,spec] of effective){
    const [providerId,modelId]=key.split('\u0000');
    const values=spec?.values;
    if(!Array.isArray(values)||values.length===0) continue;              // no level to choose: nothing is sent
    if(typeof spec.map==='string'&&dialectCount(spec.map)===1) continue; // already specific
    const provider=providers.get(providerId);
    const map=dialectMap(dialectKind(provider,modelId));
    const existing=index.get(key);
    if(existing){
      existing.config=existing.config??{};
      existing.config.optionSpecs=existing.config.optionSpecs??{};
      existing.config.optionSpecs.reasoningLevel={...(existing.config.optionSpecs.reasoningLevel??{}),values,map};
    } else {
      const rule={providerId,modelId,config:{optionSpecs:{reasoningLevel:{values,map}}}};
      rules.push(rule); index.set(key,rule);
    }
    changed.push(`${providerId.slice(0,8)}/${modelId} -> ${dialectKind(provider,modelId)}`);
  }
  return changed;
}

async function main() {
  const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!/^[0-9a-f-]{36}$/i.test(input.sessionId)) throw new Error('Invalid session identity');
  const env=input.env ?? {};
  const source=env.BOTMUX_ZCODE_SOURCE_DIR?.trim() || join(homedir(),'zcode-src');
  const builtin=env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || join(source,'config/provider/zcode-builtin.json');
  const personal=env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || join(env.ZCODE_DATA_BASE_DIR?.trim() || homedir(),'.zcode/v2/provider_config.json');
  const directory=join(resolve(input.dataDir),'zcode-runtime',input.sessionId);
  const target=join(directory,'provider_config.json');
  await mkdir(directory,{recursive:true,mode:0o700});
  const pn=await import(pathToFileURL(join(source,'packages/provider-node/src/index.ts')).href);
  const provider=await import(pathToFileURL(join(source,'packages/provider/src/index.ts')).href);
  // Decode strictly before using recovery-enabled repositories. A malformed
  // configuration must stop launch rather than silently select another model.
  const snapshot=pn.decodeProviderConfigFile(JSON.parse(await readFile(personal,'utf8')));
  const targetRepo=new pn.NodePersonalProviderConfigRepository({filePath:target,pollingIntervalMs:false});
  let runtime;
  try {
    const copy=(selection)=>({providers:snapshot.providers,models:snapshot.models,providerOrder:snapshot.providerOrder,defaultModelSelection:selection});
    await targetRepo.update(()=>copy(undefined));
    runtime=new pn.NodeProviderRegistryRuntime({zcodeBuiltinFilePath:builtin,zcodeBuiltinActiveFilePath:builtin,personalFilePath:target,personalPollingIntervalMs:false,watch:false});
    await runtime.start();
    const registry=runtime.registryService;
    let selection; let adjustment;
    if (!input.resume) {
      const requested=(input.model ?? '').trim();
      if (!requested) {
        // A cleared bot default follows the source's explicit selection, never
        // the registry's first provider or an expired subscription fallback.
        selection=snapshot.defaultModelSelection;
        if (!selection) throw new Error('Select a default ZCode model before opening a topic');
      } else {
        const providers=registry.listProviders();
        const exact=[], named=[], bare=[];
        for (const p of providers) for (const m of p.models) {
          const ref={providerId:p.providerId,modelId:m.modelId};
          if (`${p.providerId}/${m.modelId}`===requested) exact.push(ref);
          if (p.providerName && `${p.providerName}/${m.modelId}`===requested) named.push(ref);
          if (m.modelId===requested) bare.push(ref);
        }
        const matches=exact.length?exact:named.length?named:bare;
        if (matches.length!==1) throw new Error('ZCode provider/model is missing or ambiguous');
        const ref=matches[0];
        if(input.reasoningEffort){
          // An unsupported level must not brick the topic: take the closest
          // level THIS model supports (never a different model) and report it.
          const model=registry.getModel(ref.providerId,ref.modelId);
          const values=model?.config?.optionSpecs?.reasoningLevel?.values??[];
          const picked=closestLevel(values,input.reasoningEffort);
          if(!picked) throw new Error('ZCode model has no supported reasoning level');
          selection={...ref,options:{reasoningLevel:picked.level}};
          if(picked.adjusted) adjustment={requested:input.reasoningEffort,applied:picked.level};
        } else {
          selection=provider.completeNewModelSelection(registry.getView(),ref);
        }
      }
      if (!selection) throw new Error('ZCode model has no supported reasoning level');
      const validation=registry.validateSelection(selection);
      if (!validation.ok) throw new Error(`Invalid ZCode model selection: ${validation.code}`);
      await targetRepo.update(()=>copy(selection));
    }
    // Normalise reasoning dialects on the raw config, then prove the result is
    // acceptable to ZCode's own strict decoder before it is handed over.
    const effective=new Map();
    for(const p of registry.listProviders()) for(const m of p.models){
      if(m?.config?.optionSpecs?.reasoningLevel) effective.set(`${p.providerId}\u0000${m.modelId}`,m.config.optionSpecs.reasoningLevel);
    }
    const raw=JSON.parse(await readFile(personal,'utf8'));
    const changed=tuneDialects(raw,effective);
    if(selection) raw.config={...raw.config,defaultModelSelection:selection};
    pn.decodeProviderConfigFile(raw);                                // throws on anything invalid
    await writeFile(target,`${JSON.stringify(raw,null,2)}\n`,{encoding:'utf8',mode:0o600});
    if(changed.length) process.stderr.write(`zcode-dialect-guard: ${changed.length} model(s) pinned to one dialect\n`);
    await chmod(target,0o600);
    process.stdout.write(JSON.stringify({env:{ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:builtin,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:target,BOTMUX_ZCODE_RUNTIME_DIR:join(resolve(input.dataDir),'zcode-runtime')},selection:selection??null})+'\n');
  } finally { runtime?.dispose(); targetRepo.dispose(); }
}
main().catch(error=>{
  // Error detail may include schema values (including API keys). Keep stderr
  // restricted to the bridge's own errors and otherwise give a generic failure.
  const message=String(error?.message??'');
  const safe=/^(Invalid session identity|Select a default ZCode model|ZCode provider\/model is missing|ZCode model has no supported|Invalid ZCode model selection:)/.test(message);
  process.stderr.write((safe?message:'ZCode provider configuration could not be validated; inspect its schema or installed runtime')+'\n');
  process.exitCode=1;
});
