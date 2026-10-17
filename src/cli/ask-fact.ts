/** Host transport only; platform rules never enter the native Ask contract. */
export function parseAskFactCommand(args: string[]) {
  const fields = new Map([['--bot','larkAppId'],['--session','sessionId'],['--request','requestId'],['--ask','askId']]);
  const identity: Record<string,string> = {};
  for (let i=0;i<args.length;i+=2) {
    const name=fields.get(args[i]), value=args[i+1];
    if (!name || identity[name] || !value?.trim() || value.startsWith('--') || value.length>200 || /[\u0000-\u001f\u007f]/.test(value))
      throw Error('Expected --bot ID --session ID --request ID --ask ID');
    identity[name]=value;
  }
  if(Object.keys(identity).length!==4)throw Error('Original Ask identity is required');
  return { identity, path:'/api/asks/fact?'+new URLSearchParams(identity) };
}
