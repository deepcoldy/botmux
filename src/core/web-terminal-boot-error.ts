/**
 * Web 终端页的启动期报错监听（worker.ts 的 getTerminalHtml 把它原样嵌进页面，单测跑的
 * 也是这同一段源码）。
 *
 * 在组件脚本之前以捕获阶段挂到 window 的 `error` 上：组件加载失败时页面不会停在
 * 「加载中…」一片空白，而是写明原因。连上 WebSocket 后页面会把它摘掉（见
 * getTerminalHtml 里的 connect），之后良性的运行时报错不再改动健康的终端。
 *
 * **只保留第一条详情。** 组件脚本加载失败之后，主脚本顶层的 `new Terminal` 必然再抛一个
 * `ReferenceError: Can't find variable: Terminal`（Safari 文案）。原来后一条会覆盖前一条，
 * 用户只看到这个看不出原因的 ReferenceError，真正的原因「终端组件加载失败：xterm.js」被
 * 盖掉了。第一条才是根因，后面的都是连锁反应。短状态词仍每次都写回「加载失败」——
 * 主脚本在两条报错之间会把 #status 改成「初始化…」。
 *
 * 写成字符串而不是函数 + `toString()`：编译版二进制以 minify 打包，函数源码会被改写，
 * 嵌进页面的应该是固定的源码文本。源码里不能出现反引号和字面的 `</script`。
 */
export const WEB_TERMINAL_BOOT_ERROR_HANDLER_SOURCE = `(function(){
  var firstDetail=null;
  return function(event){
    var status=document.getElementById('status');
    var box=document.getElementById('boot-error');
    if(!status)return;
    var target=event.target;
    var detail='';
    if(target&&target.tagName==='SCRIPT'&&target.src){
      detail='终端组件加载失败：'+target.src.split('/').pop();
    }else if(event.message){
      detail='终端页面错误：'+event.message;
    }else{return;}
    status.textContent='加载失败';status.className='err';
    if(firstDetail!==null)return;
    firstDetail=detail;
    if(box){box.textContent=detail;box.classList.add('show');}
  };
})()`;
