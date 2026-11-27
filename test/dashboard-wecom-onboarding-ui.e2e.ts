import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {build} from 'esbuild';
import {createServer, type Server} from 'node:http';
import {readFileSync, existsSync, mkdirSync} from 'node:fs';
import {chromium, type Browser, type Page} from 'playwright';

// 非文本断言：真实生产 CSS 作为浏览器夹具，测试通过 DOM 操作及布局测量验证行为。
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
let server: Server;
let browser: Browser;
let origin: string;
beforeAll(async () => {
  const bundle = await build({entryPoints:['test/fixtures/wecom-onboarding-browser.tsx'], bundle:true, write:false, format:'iife', platform:'browser', jsx:'automatic', loader:{'.css':'empty'}});
  server = createServer((req,res) => {
    res.setHeader('content-type', req.url === '/fixture.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="botmux-csrf" content="fixture-csrf"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise<void>((done,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({headless:true, ...(!existsSync(chromium.executablePath()) && existsSync(systemChrome) ? {executablePath:systemChrome} : {})});
}, 30_000);
afterAll(async () => {await browser?.close(); await new Promise<void>(done => server?.close(() => done()));});
const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="white"/><path d="M20 20h60v60H20zm120 0h60v60h-60zM20 140h60v60H20zm80-40h20v20h-20zm40 40h60v20h-60zm0 40h20v20h-20z" fill="black"/></svg>').toString('base64')}`;
const job = (status:string, extra:Record<string,unknown> = {}) => ({id:'wecom-fixture',platform:'wecom',status,createdAt:1,updatedAt:1,appName:'项目助理',cliId:'codex',workingDir:'/workspace/demo',externalBotCreated:false,saved:false,retryable:false,...extra});
async function fixture(width = 1440, empty = false, capability: boolean | undefined = true) {
  const page = await browser.newPage({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']});
  const errors:string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const calls: Array<{url: string; search: string; method: string; body: any; csrf?: string}> = [];
  const state = {canCreateWecomBot:capability, optionsStatus:200, optionsDelay:undefined as Promise<void>|undefined, job:job('waiting_for_scan',{qrDataUrl,qrUrl:'https://example.invalid/qr',expireAt:Date.now()+120000}), restored:[] as any[], connections:[{id:'existing-connection',label:'已有企微助理',botIdHint:'…fixture',allowedUserCount:1,coreMode:'managed',configuration:'ready',gateway:'stopped',connection:'unknown',ownership:'none',canStart:true,canStop:false,canRestart:false}] as any[], delayedPoll:undefined as Promise<void>|undefined};
  await page.route('**/api/**', async route => {
    const req = route.request();
    const {pathname: path, search} = new URL(req.url());
    calls.push({
      url: path,
      search,
      method: req.method(),
      body: req.postDataJSON(),
      csrf: req.headers()['x-botmux-csrf'],
    });
    let body:unknown;
    if(path==='/api/bots')body={bots:[]};
    else if(path==='/api/wecom/connections')body={connections:state.connections};
    else if(path.startsWith('/api/wecom/connections/'))body=path.endsWith('/config')?{editable:true,revision:'r1',displayName:state.connections.find(item=>item.id===path.split('/')[4])?.label,cli:'codex',backend:'pty',model:'',workingDirectory:'/workspace/demo',requiresRestart:true}:{scope:'bot',rows:[],reserved:{keys:[],prefixes:[]},conflicts:[],sessions:[],redactedHostKeys:[],inherit:{mode:'inherit'},canReveal:false};
    else if(path==='/api/cli-options'){if(state.optionsDelay)await state.optionsDelay;body={canCreateWecomBot:state.canCreateWecomBot,options:[{id:'codex',label:'Codex',available:true,modelChoices:['gpt-6.1']}],webSession:{status:'scan_required'}};}
    else if(path==='/api/bot-onboarding/wecom-jobs')body={jobs:state.restored};
    else if(path.includes('/api/cli-options/'))body={available:true,status:'available',models:[]};
    else if(path==='/api/bot-onboarding/start')body={job:state.job};
    else if(path.endsWith('/refresh')){state.job=job('waiting_for_scan',{qrDataUrl,qrUrl:'https://example.invalid/new'});body={job:state.job};}
    else if(path.endsWith('/retry')){state.job=job('needs_pairing',{externalBotCreated:true,retryable:true,pairingCode:'NEW-PAIR-123'});body={job:state.job};}
    else if(path.endsWith('/cancel'))body={job:job('cancelled')};
    else if(path==='/api/bot-onboarding/wecom-fixture'){const captured=state.job;if(state.delayedPoll)await state.delayedPoll;body={job:captured};}
    else body={models:[]};
    await route.fulfill({status:path==='/api/cli-options'?state.optionsStatus:200,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
  });
  page.setDefaultTimeout(4000);
  if(empty)state.connections=[];
  await page.goto(origin);
  await page.waitForTimeout(100);
  if(errors.length)throw new Error(errors.join('\n'));
  try {await page.locator('.add-bot-btn').click();} catch (error) {throw new Error(`${String(error)}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`);}
  await expectNoOverflow(page);
  return {page,errors,calls,state};
}
async function expectNoOverflow(page:Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.onboarding-card').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}
// 企业微信是飞书表单首屏下方的旁路入口；切回飞书用同一位置的链接。
const WECOM_ENTRY = '改为添加企业微信机器人';
const LARK_ENTRY = '改为添加飞书机器人';
async function chooseWecom(page:Page) {await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).click();await page.locator('#ob-app-name').fill('项目助理');}
async function backToLark(page:Page) {await page.getByRole('button',{name:LARK_ENTRY,exact:true}).click();}
async function start(page:Page) {await page.getByRole('button',{name:'生成企业微信二维码',exact:true}).click();await page.locator('[data-wecom-onboarding-status="waiting_for_scan"]').waitFor();}
async function screenshot(page:Page, name:string) {if(!process.env.BOTMUX_ONBOARDING_SCREENSHOTS)return;mkdirSync('docs/screenshots',{recursive:true});await page.screenshot({path:`docs/screenshots/wecom-onboarding-${name}.png`});}

describe('Unified bot creation in the real browser DOM', () => {
  for(const width of [1440,375]) it(`opens from a WeCom-only entry and completes QR pairing at ${width}px`, async () => {
    const {page,errors,calls,state}=await fixture(width);
    try {
      await chooseWecom(page);
      expect(await page.getByText('本地显示名',{exact:true}).isVisible()).toBe(true);
      await start(page);await expectNoOverflow(page);await screenshot(page,`qr-${width}`);
      state.job=job('needs_pairing',{externalBotCreated:true,retryable:true,pairingCode:'BOTMUX-ID-0123456789abcdef0123456789abcdef'});
      await page.getByText('BOTMUX-ID-0123456789abcdef0123456789abcdef',{exact:true}).waitFor();
      await page.getByRole('button',{name:'复制配对码',exact:true}).click();await page.getByText('已复制配对码',{exact:true}).waitFor();
      expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('BOTMUX-ID-0123456789abcdef0123456789abcdef');
      await expectNoOverflow(page);await screenshot(page,`pairing-${width}`);
      expect(await page.getByRole('button',{name:'刷新二维码'}).count()).toBe(0);
      state.connections.push({...state.connections[0],id:'fixture-connection',label:'新创建企微助理',gateway:'running',connection:'connected',ownership:'fleet',desired:'running',canStart:false,canStop:true,canRestart:true});
      state.job=job('completed',{externalBotCreated:true,saved:true,liveStarted:true,connectionId:'fixture-connection'});
      await page.getByRole('button',{name:'查看机器人列表'}).waitFor();await expectNoOverflow(page);await screenshot(page,`completed-${width}`);
      await page.getByRole('button',{name:'查看机器人列表'}).click();expect(new URL(page.url()).hash).toBe('#/bot-defaults?provider=wecom&bot=fixture-connection');
      await page.locator('#bd-roster').getByText('新创建企微助理',{exact:true}).waitFor();
      await page.locator('[data-bot-name]').filter({hasText:'新创建企微助理'}).waitFor();
      expect(await page.locator('#bd-roster .bd-roster-item.on').innerText()).toContain('新创建企微助理');
      const write=calls.find(call=>call.url.endsWith('/start'))!;expect(write.body).toMatchObject({platform:'wecom',appName:'项目助理',backend:'pty',mode:'qr'});expect(write.csrf).toBe('fixture-csrf');expect(errors).toEqual([]);
    } finally {await page.close();}
  },20_000);
  it('invalidates old polls when refreshing, switching provider and closing', async () => {
    const {page,calls,state,errors}=await fixture();
    try {
      await chooseWecom(page);await start(page);
      let release!:()=>void;state.delayedPoll=new Promise<void>(done=>{release=done;});
      await expect.poll(()=>calls.filter(call=>call.url==='/api/bot-onboarding/wecom-fixture').length,{timeout:4000,interval:50}).toBe(1);
      await page.getByRole('button',{name:'刷新二维码'}).click();
      await page.locator('a[href="https://example.invalid/new"]').waitFor();
      await backToLark(page);
      release();state.delayedPoll=undefined;
      await page.waitForTimeout(100);
      expect(await page.locator('[data-wecom-onboarding-status]').count()).toBe(0);
      expect(await page.locator('#ob-app-name').isVisible()).toBe(true);
      expect(calls.some(call=>call.url.endsWith('/cancel')&&call.csrf==='fixture-csrf')).toBe(true);
      await page.getByRole('button',{name:'取消',exact:true}).click();
      expect(await page.locator('dialog.onboarding-dialog').evaluate((el:HTMLDialogElement)=>el.open)).toBe(false);expect(errors).toEqual([]);
    } finally {await page.close();}
  },15_000);
  it('refreshes an expired QR in the same local job', async () => {
    const {page,state,calls}=await fixture();
    try {await chooseWecom(page);state.job=job('failed',{error:'qr_expired'});await page.getByRole('button',{name:'生成企业微信二维码',exact:true}).click();await page.getByRole('button',{name:'刷新二维码'}).click();await page.locator('[data-wecom-onboarding-status="waiting_for_scan"]').waitFor();expect(calls.filter(call=>call.url.endsWith('/start'))).toHaveLength(1);expect(calls.find(call=>call.url.endsWith('/refresh'))?.csrf).toBe('fixture-csrf');}finally{await page.close();}
  });
  it('sends manual credentials only in POST, clears secret, and resumes the same bot after local failure', async () => {
    const {page,calls,state}=await fixture();
    try {
      await chooseWecom(page);
      await page.getByRole('radio',{name:'已有机器人'}).check();
      await page.locator('#ob-wecom-bot-id').fill('fixture-bot');await page.locator('#ob-wecom-secret').fill('private-fixture-secret');
      state.job=job('failed',{retryable:true,externalBotCreated:false,message:'本地启动尚未完成'});
      await page.getByRole('button',{name:'连接已有机器人',exact:true}).click();
      await page.getByRole('button',{name:'继续接入同一机器人'}).waitFor();
      expect(calls.find(call=>call.url.endsWith('/start'))?.body).toMatchObject({mode:'manual',botId:'fixture-bot',secret:'private-fixture-secret'});
      expect(await page.locator('body').innerText()).not.toContain('private-fixture-secret');
      await page.getByRole('button',{name:'继续接入同一机器人'}).click();await page.getByText('NEW-PAIR-123',{exact:true}).waitFor();
      expect(calls.filter(call=>call.url.endsWith('/start'))).toHaveLength(1);
      expect(calls.find(call=>call.url.endsWith('/retry'))?.csrf).toBe('fixture-csrf');
      await backToLark(page);await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).click();await page.getByRole('radio',{name:'已有机器人'}).check();expect(await page.locator('#ob-wecom-secret').inputValue()).toBe('');
      expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('private-fixture-secret');
    } finally {await page.close();}
  },15_000);
  it('opens straight on the Feishu form and offers no WeCom entry without host capability', async () => {
    const {page,calls,errors}=await fixture(375,false,false);
    try {
      await page.locator('#ob-app-name').waitFor();
      // 配置页自己会带 probe=none 拉一次选项；这里只数向导打开时发的那一次。
      const wizardOptionRequests = () => calls.filter(call =>
        call.url === '/api/cli-options' && new URLSearchParams(call.search).get('probe') !== 'none');
      await expect.poll(() => wizardOptionRequests().length).toBe(1);
      expect(await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).count()).toBe(0);
      await screenshot(page,'permission-375');await expectNoOverflow(page);expect(errors).toEqual([]);
    } finally {await page.close();}
  });
  it('shows the WeCom entry only once the capability check confirms it, and switching does not refetch options', async () => {
    const {page,state,errors,calls}=await fixture();
    try {
      await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).waitFor({state:'visible'});
      await page.getByRole('button',{name:'取消',exact:true}).click();
      let release!:()=>void;state.optionsDelay=new Promise<void>(done=>{release=done;});state.optionsStatus=503;
      await page.locator('.add-bot-btn').click();
      await page.locator('#ob-app-name').waitFor();
      expect(await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).count()).toBe(0);
      release();state.optionsDelay=undefined;
      await page.waitForTimeout(100);
      expect(await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).count()).toBe(0);
      await page.getByRole('button',{name:'取消',exact:true}).click();
      state.optionsStatus=200;state.canCreateWecomBot=true;
      await page.locator('.add-bot-btn').click();
      await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).waitFor({state:'visible'});
      const before=calls.filter(call=>call.url==='/api/cli-options').length;
      await chooseWecom(page);await backToLark(page);await chooseWecom(page);
      expect(calls.filter(call=>call.url==='/api/cli-options')).toHaveLength(before);expect(errors).toEqual([]);
    } finally {await page.close();}
  });
  it('opens the Feishu form with the WeCom entry when no bot is configured', async () => {
    const {page,errors}=await fixture(375,true);
    try {await page.locator('#ob-app-name').waitFor();await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).waitFor({state:'visible'});expect(errors).toEqual([]);}finally{await page.close();}
  });
  it('finds cancelled jobs after reopening and resumes without another external creation', async () => {
    const {page,state,calls}=await fixture();
    try {
      state.restored=[job('cancelled',{externalBotCreated:true,retryable:true})];
      await page.getByRole('button',{name:WECOM_ENTRY,exact:true}).click();
      await page.getByRole('button',{name:'继续接入同一机器人'}).click();
      await page.getByText('NEW-PAIR-123',{exact:true}).waitFor();
      expect(calls.filter(call=>call.url.endsWith('/start'))).toHaveLength(0);
    } finally {await page.close();}
  },15_000);
});
