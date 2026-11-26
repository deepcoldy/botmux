import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { parseBytedcliMachineProfile } from './bytedcli-broker-credentials.js';
/** Frozen once at host assembly. PATH is daemon startup configuration, never
 * Bot/Agent env, and discover validates canonical install/runtime ownership. */
export function bytedcliTrustedHostLayout(settings:{readonly machineProfile?:string;readonly protectedRoots?:readonly string[]}={}){
  const machineHome=homedir(),path=process.env.PATH??'/usr/local/bin:/usr/bin:/bin';
  const directories=path.split(delimiter).filter(isAbsolute);
  const candidates=directories.map(dir=>join(dir,'bytedcli')).filter(existsSync).flatMap(file=>{try{return [realpathSync(file)];}catch{return [];}});
  const runtimeCandidates=directories.map(dir=>join(dir,'node')).filter(existsSync);
  const runtimeExecutable=runtimeCandidates[0]??'/usr/bin/node';
  const installationRoots=[...new Set(candidates.map(file=>dirname(dirname(file))))];
  const privateRoot=join(machineHome,'.botmux','host-authority','bytedcli-broker');
  const auditRoot=join(privateRoot,'audit');
  const credentialRoots=[join(machineHome,'.local','share','bytedcli'),join(machineHome,'.botmux','data','bytedcli-home'),
    join(machineHome,'.botmux','data','cli-auth-epoch'),join(machineHome,'.botmux','host-authority'),
    join(machineHome,'.botmux','device-auth'),join(machineHome,'.botmux','platform.json'),join(machineHome,'.git-credentials'),join(machineHome,'.gitconfig'),join(machineHome,'.netrc'),join(machineHome,'.ssh'),
    join(machineHome,'.botmux','data','meego-home'),join(machineHome,'.meegle'),
    join(machineHome,'.botmux','.env'),join(machineHome,'.config','bytedcli'),
    join(machineHome,'.config','git'),'/etc/gitconfig',
    join(machineHome,'.config','codebase'),join(machineHome,'.codebase'),
    join(machineHome,'.bits'),join(machineHome,'.bits-cli'),join(machineHome,'.config','bitscli'),
    join(machineHome,'.relay','byted-cloud-auth.json'),join(machineHome,'.claude-runtime','byted-cloud-auth.json'),
    ...['BYTEDCLI_CONFIG_DIR','BYTEDCLI_HOME','BOTS_CONFIG','SSH_AUTH_SOCK','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM'].flatMap(key=>process.env[key]&&isAbsolute(process.env[key]!)?[process.env[key]!]:[]),
    ...['AIME_WORKSPACE_PATH','AILY_WORKSPACE_PATH','AILY_WORKSPACE_DIR'].flatMap(key=>process.env[key]&&isAbsolute(process.env[key]!)?[process.env[key]!]:[]),
    ...(settings.protectedRoots??[])];
  const executableReadOnlyRoots=[...installationRoots,...directories.filter(dir=>existsSync(join(dir,'bytedcli'))),...directories.map(dir=>join(dir,'bytedcli')).filter(existsSync),
    runtimeExecutable,dirname(runtimeExecutable)];
  const protectedRoots=[...credentialRoots,...executableReadOnlyRoots];
  if(protectedRoots.some(root=>!isAbsolute(root)||root.startsWith('/$bunfs/')))throw new Error('invalid trusted protected root');
  const canonicalAliases=(paths:readonly string[])=>Object.freeze([...new Set(paths.flatMap(root=>{
    let ancestor=root;const suffix:string[]=[];
    while(!existsSync(ancestor)&&dirname(ancestor)!==ancestor){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
    try{return [root,join(realpathSync(ancestor),...suffix)];}catch{return [root];}
  }))]);
  const aliases=canonicalAliases(protectedRoots);
  const networkEnv:NodeJS.ProcessEnv={};
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR']){
    if(process.env[key])networkEnv[key]=process.env[key];
  }
  return Object.freeze({machineHome,path,candidates:Object.freeze(candidates),runtimeExecutable,
    installationRoots:Object.freeze(installationRoots),privateRoot,auditRoot,machineProfile:parseBytedcliMachineProfile(settings.machineProfile),credentialRoots:canonicalAliases(credentialRoots),
    executableReadOnlyRoots:canonicalAliases(executableReadOnlyRoots),protectedRoots:aliases,networkEnv:Object.freeze(networkEnv)});
}
export type BytedcliHostLayout=ReturnType<typeof bytedcliTrustedHostLayout>;

let frozenLayout: BytedcliHostLayout | undefined;
/** Machine configuration must be installed before the first worker/broker. */
export function freezeBytedcliHostLayout(layout?: BytedcliHostLayout): BytedcliHostLayout {
  if (layout && frozenLayout && layout !== frozenLayout) throw new Error('ByteCloud host layout already frozen');
  return frozenLayout ??= layout ?? bytedcliTrustedHostLayout();
}
