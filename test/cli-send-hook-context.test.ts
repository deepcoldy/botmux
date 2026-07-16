import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

describe('cmdSend hook context wiring', () => {
  it('passes the current session id into outbound send/reply hooks', () => {
    expect(cliSource).toContain('const hookContext = {');
    expect(cliSource).toMatch(/sendMessage\(\s*appId,\s*sendTarget\.chatId,\s*content,\s*msgType,\s*uuid,\s*hookContext,/);
    expect(cliSource).toMatch(/replyMessage\(\s*appId,\s*sendTarget\.rootMessageId,\s*content,\s*msgType,\s*true,\s*uuid,\s*hookContext,/);
  });

  it('resolves mention-back from the explicit VC turn instead of the latest queued sender', () => {
    expect(cliSource).toContain(
      'const replyTargetSenderOpenId = explicitVcMeetingImOrigin?.replyTargetSenderOpenId',
    );
    expect(cliSource).toContain('hasQuoteTargetSender: !!replyTargetSenderOpenId');
    expect(cliSource).toMatch(/mentions\.push\(\{ open_id: replyTargetSenderOpenId, name: '' \}\)/);
  });

  it('freezes VC listener replay content and indexes only the successful primary output', () => {
    const cmdSendStart = cliSource.indexOf('async function cmdSend(');
    const cmdDispatchStart = cliSource.indexOf('async function cmdDispatch(', cmdSendStart);
    const cmdSend = cliSource.slice(cmdSendStart, cmdDispatchStart);
    expect(cmdSend).toContain('const canonicalOutput = prepared?.canonicalOutput ?? proposedOutput;');
    expect(cmdSend).toContain('prepareVcMeetingDeliveryReply(');
    expect(cmdSend).toContain('vcMeetingDeliveryReplyOrigin');
    expect(cmdSend).toContain('content: canonicalOutput.content');
    expect(cmdSend).toContain('msgType: canonicalOutput.msgType');
    expect(cmdSend).toContain('quoteTargetId: canonicalOutput.quoteTargetId');
    expect(cmdSend).toMatch(
      /const dispatch = \([^)]*\): Promise<string> => \{[\s\S]*?revalidateVcMeetingManagedSend\(\);/,
    );
    expect(cmdSend).toMatch(
      /const dispatchPrimary = async \([^)]*\): Promise<string> => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*revalidateVcMeetingManagedSend\(\);/,
    );
    expect(cmdSend).toContain('recordVcMeetingPrimaryOutput(result.messageId, canonicalOutput.targetChatId);');
    expect(cmdSend.indexOf('recordVcMeetingPrimaryOutput(result.messageId'))
      .toBeGreaterThan(cmdSend.indexOf('const result = await dispatchPrimaryMessage('));
    expect(cmdSend).toContain('const managedControlError = managedVcSendControlError({');
    expect(cmdSend).toContain('const managedPayloadError = managedVcSendPayloadError({');
    expect(cmdSend).toContain('fileCount: files.length');
    expect(cmdSend).toContain('videoCount: videoAttachments.length');
    expect(cmdSend).toContain('containsNativeAtTag: containsLarkAtTag(content)');
    expect(cmdSend).toContain('const managedRenderedPayloadError = managedVcSendPayloadError({');
    expect(cmdSend).toContain('containsNativeAtTag: containsLarkAtTag(text)');
    expect(cmdSend).toContain('if (!noMention && !vcMeetingManagedSendOrigin)');
    expect(cmdSend).toContain('if (!sendTopLevel && !vcMeetingManagedSendOrigin)');
    expect(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf("const { sendMessage, replyMessage, uploadImage, uploadFile"));
    expect(cmdSend.indexOf('const managedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf("const { synthesizeVoiceOpus }"));
    expect(cmdSend.indexOf('const managedRenderedPayloadError = managedVcSendPayloadError({'))
      .toBeGreaterThan(cmdSend.indexOf('BOTMUX_CARD_PREPARED_CONTENT_FILE'));
    expect(cmdSend.indexOf('const managedRenderedPayloadError = managedVcSendPayloadError({'))
      .toBeLessThan(cmdSend.indexOf('const results = await Promise.all(images.map'));
    expect(cmdSend).toContain('const managedQuoteError = managedVcQuoteError({');
    expect(cmdSend).toContain('const managedCustomCardError = managedVcCustomCardError(');
    expect(cmdSend).toMatch(/sessionQuoteTargetId: vcMeetingDeliveryReplyOrigin\s*\? undefined/);
    expect(cmdSend).toContain('const prepared = prepareVcMeetingListenerReply(proposedOutput);');
    expect(cmdSend).toMatch(/canonicalOutput\.msgType,[\s\S]*?prepared\?\.providerKey/);
    expect(cmdSend).toContain('...(prepared ? { suppressHook: true } : {})');
    expect(cmdSend).toContain('const managedProviderOptions = prepared');
    expect(cmdSend).toContain('...(vcMeetingManagedSendOrigin ? { maxMessages: 1 } : {})');
  });
});
