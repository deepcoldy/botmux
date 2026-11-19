import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({link:vi.fn(),brand:'feishu'}));
vi.mock('../src/bot-registry.js',()=>({getBotClient:()=>({request:mocks.link}),getBot:()=>({config:{brand:mocks.brand}}),getAllBots:()=>[],loadBotConfigs:()=>[]}));
vi.mock('../src/utils/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()}}));
import { getChatInviteLink } from '../src/im/lark/client.js';
beforeEach(()=>{mocks.link.mockReset();mocks.brand='feishu';});
describe('native chat invitation',()=>{
 it.each([['feishu','applink.feishu.cn'],['feishu','applink.larkoffice.com'],['lark','applink.larksuite.com']])('uses a permanent %s invitation from %s without rewriting its token',async(brand,host)=>{
  mocks.brand=brand;const link=`https://${host}/client/chat/chatter/add_by_link?link_token=synthetic%2Ftoken`;
  mocks.link.mockResolvedValue({code:0,data:{is_permanent:true,share_link:link}});
  expect(await getChatInviteLink('app','oc_created')).toBe(link);
  expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({method:'POST',url:'/open-apis/im/v1/chats/oc_created/link',data:{validity_period:'permanently'},timeout:expect.any(Number)}));
 });
 it.each([
  {code:99991672}, {code:0,data:{is_permanent:false,share_link:'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=x'}},
  {code:0,data:{is_permanent:true,share_link:'https://outside.test/?link_token=x'}},
  {code:0,data:{is_permanent:true,share_link:'https://applink.larkoffice.com.outside.test/client/chat/chatter/add_by_link?link_token=x'}},
  {code:0,data:{is_permanent:true,share_link:'https://applink.feishu.cn/client/chat/open?openChatId=oc_created'}},
  {code:0,data:{is_permanent:true,share_link:'https://user:secret@applink.feishu.cn/client/chat/chatter/add_by_link?link_token=x'}},
 ])('refuses failed, expiring or non-invitation responses',async response=>{
  mocks.link.mockResolvedValue(response);await expect(getChatInviteLink('app','oc_created')).rejects.toThrow();
 });
 it('does not treat a Feishu invitation as a Lark tenant invitation',async()=>{
  mocks.brand='lark';mocks.link.mockResolvedValue({code:0,data:{is_permanent:true,share_link:'https://applink.larkoffice.com/client/chat/chatter/add_by_link?link_token=x'}});
  await expect(getChatInviteLink('app','oc_created')).rejects.toThrow();
 });
});
