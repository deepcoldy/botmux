"""Linux process integration: real dist/daemon/Worker/runner/ask CLI; fake IM + model only.
Run after build: python3 src/core/__tests__/fixtures/ask-runtime/run.py --node /absolute/node
Keeps evidence in its temporary root. Never writes the host's bot data or homes.
"""
import argparse, collections, json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request, uuid

HERE = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=pathlib.Path, default=HERE.parents[4])
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--output', type=pathlib.Path)
args = parser.parse_args()
repo = args.repo.resolve()
assert (repo/'dist/daemon.js').exists(), 'build the candidate first'
assert shutil.which('bwrap'), 'Linux bubblewrap is required for safe isolation'
assert int(subprocess.check_output([args.node,'-p','process.versions.node.split(".")[0]'],text=True)) >= 22
root = pathlib.Path(tempfile.mkdtemp(prefix='botmux-ask-runtime-'))
home = pathlib.Path.home().resolve()
for name in ['botmux','data','workspace','tmp','releases','cache','codex']:
    (root/name).mkdir()
(root/'botmux/releases').symlink_to(root/'releases',target_is_directory=True)
fixture = (repo/'test/fixtures/fake-codex-app-server.mjs').read_text()
assert fixture.count('  turnAttempt += 1;') == 1
fixture = fixture.replace("'thread-fake'", "('thread-fixture-' + process.env.BOTMUX_SESSION_ID)")
fixture = fixture.replace('  turnAttempt += 1;', '  turnAttempt += 1;\n'+(HERE/'model-ask.txt').read_text())
(root/'fake-codex.mjs').write_text(fixture)
(root/'fake-codex.mjs').chmod(0o755)
config = [{'name':'Runtime isolated fixture','larkAppId':'cli_runtime_fixture','larkAppSecret':'fixture-only',
           'ownerOpenId':'ou_runtime_owner','allowedUsers':['ou_runtime_owner'],'p2pMode':'thread',
           'cliId':'codex-app','cliPathOverride':str(root/'fake-codex.mjs'),'backendType':'pty',
           'defaultWorkingDir':str(root/'workspace'),'workingDir':str(root/'workspace'),'sandbox':False,'cotEnabled':False,
           'env':{'BOTMUX_TEST_ROOT':str(root),'BOTMUX_ASK_DELIVERY_MODE':'continuation',
                  'FAKE_CODEX_LOG':str(root/'model.jsonl'),'FAKE_CODEX_FINAL_TEXT':'Runtime fixture turn completed'}}]
# BOTMUX_TEST_ROOT is test-only and deliberately not a config exception. A normal
# application variable reaches the fixture, which maps it internally before use.
config[0]['env']['ASK_RUNTIME_ROOT'] = config[0]['env'].pop('BOTMUX_TEST_ROOT')
fixture = fixture.replace('process.env.BOTMUX_TEST_ROOT','process.env.ASK_RUNTIME_ROOT')
(root/'fake-codex.mjs').write_text(fixture)
(root/'botmux/bots.json').write_text(json.dumps(config))
(root/'botmux/config.json').write_text('{}')

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0))
        return s.getsockname()[1]

control, ipc, web = port(), port(), port()
env = {k:os.environ[k] for k in ['PATH','HOME','LANG','TERM'] if k in os.environ}
env.update({'BOTS_CONFIG':str(root/'botmux/bots.json'),'SESSION_DATA_DIR':str(root/'data'),
            'BOTMUX_TEST_ROOT':str(root),'BOTMUX_TEST_REPO':str(repo),'BOTMUX_TEST_CONTROL_PORT':str(control),
            'BOTMUX_DAEMON_IPC_BASE_PORT':str(ipc),'BOTMUX_WEB_PROXY_BASE_PORT':str(web),
            'BOTMUX_WORKER_HTTP_HOST':'127.0.0.1','WEB_HOST':'127.0.0.1','TMPDIR':str(root/'tmp'),
            'STUCK_DETECTOR_ENABLED':'false','NODE_ENV':'test'})
cmd = ['bwrap','--die-with-parent','--unshare-pid','--new-session','--ro-bind','/','/',
       '--tmpfs','/tmp','--tmpfs','/run/user/'+str(os.getuid()),'--bind',str(root),str(root)]
if (home/'.botmux/releases').exists():
    cmd += ['--ro-bind',str(home/'.botmux/releases'),str(root/'releases')]
for src,dest in [('botmux','.botmux'),('cache','.cache'),('codex','.codex')]:
    cmd += ['--bind',str(root/src),str(home/dest)]
cmd += ['--dev','/dev','--proc','/proc','--chdir',str(root/'workspace'),'--',args.node,str(HERE/'host.mjs')]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
base = 'http://127.0.0.1:'+str(control)
process = None
generation = 0
checks = []

def request(path, body=None, drop=False):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base+path+('?drop=1' if drop else ''),data=data,headers={'Content-Type':'application/json'})
    try:
        response = json.load(opener.open(req, timeout=15))
    except Exception:
        if drop:
            return None
        raise
    assert not drop, 'response loss was not injected'
    assert response.get('ok'), response
    return response.get('result')

def wait_for(label, read, predicate, timeout=75):
    deadline = time.monotonic()+timeout
    last = None
    while time.monotonic()<deadline:
        if process is not None and process.poll() is not None:
            raise AssertionError(f'host exited: {process.returncode}; {root}')
        try:
            last = read()
            if predicate(last):
                print(label, 'passed', flush=True)
                return last
        except (ConnectionError, OSError):
            pass
        time.sleep(.2)
    raise AssertionError(f'{label} timed out: {str(last)[:3000]}')

def state():
    return request('/state')

def start():
    global process,generation
    generation += 1
    with (root/f'host-{generation}.log').open('w') as log:
        process = subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT)
    wait_for(f'host generation {generation}',state,lambda s:s['ready'])

def stop():
    global process
    if process is not None and process.poll() is None:
        process.kill()  # PID namespace terminates daemon, Workers and CLIs together.
        process.wait(timeout=15)
    process = None

def envelope(kind,event):
    return {'schema':'2.0','header':{'event_id':str(uuid.uuid4()),'event_type':kind,'app_id':'cli_runtime_fixture',
            'tenant_key':'fixture','create_time':str(int(time.time()*1000))},'event':event}

def message(case,chat_type):
    m={'message_id':'om_fixture_'+case,'chat_id':'oc_fixture_'+case,'chat_type':chat_type,'message_type':'text',
       'create_time':str(int(time.time()*1000)),'content':json.dumps({'text':'Run the isolated runtime verification task.'})}
    if chat_type=='group':
        m['mentions']=[{'key':'@_user_1','id':{'open_id':'ou_runtime_bot'},'name':'Fixture bot','tenant_key':'fixture'}]
        m['content']=json.dumps({'text':'@_user_1 Run the isolated runtime verification task.'})
    return envelope('im.message.receive_v1',{'sender':{'sender_id':{'open_id':'ou_runtime_owner','union_id':'on_fixture_owner'},
                    'sender_type':'user','tenant_key':'fixture'},'message':m})

def callback(ask, actor='ou_runtime_owner'):
    im = json.loads((root/'external-im.json').read_text())
    card = json.loads(im['messages'][ask['cardMessageId']]['body']['content'])
    values=[]
    def visit(obj):
        if isinstance(obj,dict):
            if obj.get('tag')=='button' and obj.get('value',{}).get('key')=='continue':
                values.append(obj['value'])
            for value in obj.values(): visit(value)
        elif isinstance(obj,list):
            for value in obj: visit(value)
    visit(card)
    assert len(values)==1
    return envelope('card.action.trigger',{'operator':{'open_id':actor,'union_id':'on_fixture_owner' if actor=='ou_runtime_owner' else 'on_wrong'},
                    'context':{'open_message_id':ask['cardMessageId'],'open_chat_id':ask['chatId']},
                    'action':{'tag':'button','value':values[0]}})

def turns():
    if not (root/'model.jsonl').exists(): return []
    return [json.loads(x) for x in (root/'model.jsonl').read_text().splitlines() if json.loads(x).get('method')=='turn/start']

result={'status':'running','root':str(root),'repo':str(repo),'checks':checks,
        'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
        'boundary':'Real built daemon/Worker/runner/CLI/queue/storage/card gateway; deterministic model and external IM transport.'}
try:
    start()
    for case,kind in [('topic','p2p'),('group_a','group'),('group_b','group')]:
        request('/event',message(case,kind))
    initial=wait_for('three real CLI registrations without --host-wait',state,
                     lambda s:len(s['waits'])==3 and len(list(root.glob('ask-command-*.json')))==3)
    asks=sorted(initial['asks'],key=lambda a:a['chatId'])
    assert len(asks)==3 and all(a.get('deadlineAt') == 9007199254740991 for a in asks)
    for a in asks:
        s=next(s for s in initial['sessions'] if s['sessionId']==a['sessionId'])
        assert s['ownerOpenId']=='ou_runtime_owner'
        expected_scope = 'thread' if a['chatType']=='p2p' else 'chat'
        assert s['scope']==expected_scope
        expected_root = 'om_fixture_topic' if expected_scope=='thread' else None
        assert a['rootMessageId']==expected_root
        command=json.loads((root/f"ask-command-{a['sessionId']}.json").read_text())
        assert command['code']==0 and command['mode']=='continuation',command
    assert len(turns())==3
    checks.append('three independent topic/group sessions; configured mode; CLI exited before answer; no business expiry')
    rejected=request('/event',callback(asks[0],'ou_wrong'))
    assert '申请授权' in rejected.get('toast',{}).get('content',''),rejected
    assert len(state()['asks'])==3
    checks.append('real card gateway rejects wrong actor and preserves answerable original')
    # First model turns have completed through the real runner. Kill every process
    # and reopen the SAME SQLite/data root; no test reset or synthetic receipt.
    wait_for('all original model turns terminal before answers',
             lambda:(root/'host-1.log').read_text(),lambda log:log.count('(turn_terminal)')==3)
    stop()
    start()
    restored=wait_for('durable asks after real cold restart',state,lambda s:len(s['asks'])==3)
    assert {a['askId'] for a in restored['asks']}=={a['askId'] for a in asks}
    checks.append('actual process termination and cold restore preserve all ask/session identities')
    events=[callback(a) for a in asks]
    request('/event',events[0],drop=True)
    for event in events:
        request('/event',event)
        request('/event',envelope('card.action.trigger',event['event']))
    final=wait_for('three continuations committed by real native queue',state,
                   lambda s:len(s['waits'])==3 and all(w.get('continuation',{}).get('state')=='committed' for w in s['waits']))
    wait_for('exactly one successor per original model thread',turns,lambda t:len(t)==6)
    counts=collections.Counter(t['params']['threadId'] for t in turns())
    assert set(counts.values())=={2},counts
    for registration in final['registrations']:
        evidence=registration['evidence']
        assert evidence['status']==200 and evidence['body']['inputCommitted']['state']=='observed',evidence
    checks.append('response loss plus duplicate callbacks: one native input commit and one successor per original session')
    wait_for('answer turns terminal', lambda:(root/'host-2.log').read_text(), lambda log:log.count('(turn_terminal)')==3)
    for case,kind in [('topic','p2p'),('group_a','group'),('group_b','group')]:
        followup=message(case,kind)
        followup['event']['message']['message_id']='om_fixture_followup_'+case
        if kind=='p2p':
            followup['event']['message']['root_id']='om_fixture_topic'
            followup['event']['message']['thread_id']='omt_fixture_topic'
        request('/event',followup)
    def proofs():
        return [json.loads(x) for x in (root/'execution-proofs.jsonl').read_text().splitlines()]
    observed=wait_for('current execution on subsequent turns of persistent engines',proofs,lambda values:len(values)==9)
    assert all(p['code']==0 and json.loads(p['stdout'])['status']=='verified' for p in observed),observed
    assert all(json.loads(p['stdout'])['sessionId']==p['sessionId'] for p in observed)
    counts=collections.Counter(t['params']['threadId'] for t in turns())
    assert set(counts.values())=={3} and len(counts)==3,counts
    checks.append('real execution current succeeds on opening, restored and subsequent persistent-engine turns')
    wait_for('followup turns terminal', lambda:(root/'host-2.log').read_text(), lambda log:log.count('(turn_terminal)')==6)
    stop()
    start()
    settled=wait_for('committed answers remain settled after second cold restart',state,
                     lambda s:len(s['waits'])==3 and all(w.get('continuation',{}).get('state')=='committed' for w in s['waits']))
    for event in events: request('/event',event)
    time.sleep(2)
    assert len(turns())==9
    checks.append('post-commit cold restart and replay do not execute answers again')
    result.update(status='passed',initial=initial,final=final,settled=settled,turnCounts=dict(counts))
except BaseException as error:
    result.update(status='failed',error=repr(error))
    raise
finally:
    stop()
    output=args.output or root/'result.json'
    output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'status':result['status'],'root':str(root),'evidence':str(output)}),flush=True)
