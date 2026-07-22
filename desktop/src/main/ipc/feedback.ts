import os from 'node:os'
import { app, ipcMain, net } from 'electron'

// Why: the production Mac build loads the renderer from a file:// origin, so a
// cross-origin POST from fetch() triggers a CORS preflight that the feedback
// endpoint rejects. Electron's net module runs in the main process and is not
// subject to CORS, so we proxy the submission through IPC. This mirrors the
// same pattern used by updater-changelog.ts and updater-nudge.ts.
//
// Hosts are env-only so open-source trees never embed private infrastructure:
//   BOTMUX_FEEDBACK_API_URL           primary POST target
//   BOTMUX_FEEDBACK_API_FALLBACK_URL  optional fallback (5xx / network errors)
const FEEDBACK_REQUEST_TIMEOUT_MS = 10_000
const FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS = 60_000
const DIAGNOSTIC_BUNDLE_CONTENT_TYPE = 'application/x-ndjson'
// Why: corporate filters can reject multipart with 403 while allowing the
// small JSON report, so content-shaped failures should shed the attachment.
const DIAGNOSTIC_BUNDLE_JSON_RETRY_STATUSES = new Set([400, 403, 408, 413, 415, 422])

export type FeedbackApiEndpoints = {
  primary: string
  fallback: string | null
}

/** Resolve feedback endpoints from env (no hardcoded hosts). */
export function getFeedbackApiEndpoints(
  env: NodeJS.ProcessEnv = process.env
): FeedbackApiEndpoints | null {
  const primary = env.BOTMUX_FEEDBACK_API_URL?.trim() ?? ''
  if (!primary) {
    return null
  }
  const fallback = env.BOTMUX_FEEDBACK_API_FALLBACK_URL?.trim() || null
  return { primary, fallback: fallback && fallback !== primary ? fallback : null }
}

export type FeedbackSubmissionType = 'feedback' | 'crash'

export type FeedbackSubmitArgs = {
  feedback: string
  submitAnonymously?: boolean
  githubLogin: string | null
  githubEmail: string | null
}

export type FeedbackDiagnosticBundleAttachment = {
  bundleSubmissionId: string
  content: string
  bytes: number
  spanCount: number
}

type FeedbackSubmitBody = {
  feedback: string
  submissionType: FeedbackSubmissionType
  githubLogin: string | null
  githubEmail: string | null
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
}

export type FeedbackRequestFailure = {
  status: number | null
  error: string
}

export type FeedbackSubmitResult =
  | { ok: true; diagnosticBundleFailure?: FeedbackRequestFailure }
  | ({ ok: false } & FeedbackRequestFailure & {
        diagnosticBundleFailure?: FeedbackRequestFailure
      })

type InternalFeedbackSubmitArgs = FeedbackSubmitArgs & {
  submissionType?: FeedbackSubmissionType
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
  feedbackWithoutDiagnosticBundle?: string
}

// Why: the Slack notification and any follow-up investigation need to know
// which Botmux build and which OS the feedback came from. The main process is
// the only place with trusted access to these values (app.getVersion and the
// node os module), so we enrich the payload here rather than trusting the
// renderer.
function buildSubmitBody(args: InternalFeedbackSubmitArgs): FeedbackSubmitBody {
  const identity = args.submitAnonymously
    ? { githubLogin: null, githubEmail: null }
    : { githubLogin: args.githubLogin, githubEmail: args.githubEmail }

  // Why: anonymity is an IPC-only privacy decision. Allow-list fields here so
  // stale renderer state or future identity-shaped fields cannot leak upstream.
  return {
    feedback: args.feedback,
    submissionType: args.submissionType ?? 'feedback',
    ...identity,
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    ...(args.submissionType === 'crash' && args.diagnosticBundle
      ? { diagnosticBundle: args.diagnosticBundle }
      : {})
  }
}

async function postFeedback(
  url: string,
  body: FeedbackSubmitBody,
  timeoutMs = FEEDBACK_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  // Why: a silent feedback endpoint should not leave IPC or crash-report
  // submission flows pending forever.
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const init: RequestInit = {
      method: 'POST',
      ...feedbackRequestBodyInit(body),
      signal: controller.signal
    }
    return await net.fetch(url, init)
  } catch (error) {
    // Why: Electron and Node use different AbortError messages. Normalize our
    // client deadline so support logs explain which request budget expired.
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs / 1000} seconds`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function feedbackRequestBodyInit(body: FeedbackSubmitBody): Pick<RequestInit, 'body' | 'headers'> {
  if (!body.diagnosticBundle) {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  }

  const formData = new FormData()
  appendFeedbackFormField(formData, 'feedback', body.feedback)
  appendFeedbackFormField(formData, 'submissionType', body.submissionType)
  appendFeedbackFormField(formData, 'githubLogin', body.githubLogin)
  appendFeedbackFormField(formData, 'githubEmail', body.githubEmail)
  appendFeedbackFormField(formData, 'appVersion', body.appVersion)
  appendFeedbackFormField(formData, 'platform', body.platform)
  appendFeedbackFormField(formData, 'osRelease', body.osRelease)
  appendFeedbackFormField(formData, 'arch', body.arch)
  appendFeedbackFormField(
    formData,
    'diagnosticBundleSubmissionId',
    body.diagnosticBundle.bundleSubmissionId
  )
  appendFeedbackFormField(formData, 'diagnosticBundleBytes', String(body.diagnosticBundle.bytes))
  appendFeedbackFormField(
    formData,
    'diagnosticBundleSpanCount',
    String(body.diagnosticBundle.spanCount)
  )
  formData.append(
    'diagnosticBundleFile',
    new Blob([body.diagnosticBundle.content], { type: DIAGNOSTIC_BUNDLE_CONTENT_TYPE }),
    `botmux-diagnostics-${body.diagnosticBundle.bundleSubmissionId}.ndjson`
  )

  // Why: multipart avoids JSON-escaping a near-cap NDJSON bundle over the
  // backend request limit while still submitting one feedback request.
  return { body: formData }
}

function appendFeedbackFormField(formData: FormData, key: string, value: string | null): void {
  if (value !== null) {
    formData.append(key, value)
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function responseFailure(response: Response): FeedbackRequestFailure {
  return { status: response.status, error: `status ${response.status}` }
}

function errorFailure(error: unknown): FeedbackRequestFailure {
  return { status: null, error: messageFromError(error) }
}

async function submitFallbackFeedback(
  body: FeedbackSubmitBody,
  fallbackUrl: string | null,
  primaryError?: unknown
): Promise<FeedbackSubmitResult> {
  if (!fallbackUrl) {
    if (primaryError === undefined) {
      return { ok: false, status: null, error: 'feedback fallback is not configured' }
    }
    return { ok: false, status: null, error: messageFromError(primaryError) }
  }
  try {
    const fallback = await postFeedback(fallbackUrl, body)
    if (fallback.ok) {
      return { ok: true }
    }
    return { ok: false, status: fallback.status, error: `status ${fallback.status}` }
  } catch (fallbackError) {
    const message = messageFromError(fallbackError)
    if (primaryError === undefined) {
      return { ok: false, status: null, error: message }
    }
    return {
      ok: false,
      status: null,
      error: `${messageFromError(primaryError)}; fallback: ${message}`
    }
  }
}

function diagnosticRetryUrl(
  status: number,
  endpoints: FeedbackApiEndpoints
): string | null {
  if (DIAGNOSTIC_BUNDLE_JSON_RETRY_STATUSES.has(status)) {
    return endpoints.primary
  }
  if ((status === 404 || status >= 500) && endpoints.fallback) {
    return endpoints.fallback
  }
  return null
}

async function submitFeedbackWithoutDiagnosticBundle(
  url: string,
  body: FeedbackSubmitBody,
  diagnosticBundleFailure: FeedbackRequestFailure
): Promise<FeedbackSubmitResult> {
  try {
    const response = await postFeedback(url, body)
    if (response.ok) {
      return { ok: true, diagnosticBundleFailure }
    }
    return { ok: false, ...responseFailure(response), diagnosticBundleFailure }
  } catch (error) {
    return { ok: false, ...errorFailure(error), diagnosticBundleFailure }
  }
}

async function submitFeedbackWithDiagnosticBundle(
  body: FeedbackSubmitBody,
  bodyWithoutDiagnosticBundle: FeedbackSubmitBody | null,
  endpoints: FeedbackApiEndpoints
): Promise<FeedbackSubmitResult> {
  try {
    // Why: diagnostic bundles can approach 4 MiB and need more upload time than
    // the small JSON report-only path, especially on constrained connections.
    const response = await postFeedback(
      endpoints.primary,
      body,
      FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS
    )
    if (response.ok) {
      return { ok: true }
    }
    const failure = responseFailure(response)
    if (bodyWithoutDiagnosticBundle) {
      const retryUrl = diagnosticRetryUrl(response.status, endpoints)
      if (retryUrl) {
        return submitFeedbackWithoutDiagnosticBundle(retryUrl, bodyWithoutDiagnosticBundle, failure)
      }
    }
    return { ok: false, ...failure }
  } catch (error) {
    const failure = errorFailure(error)
    if (!bodyWithoutDiagnosticBundle) {
      return { ok: false, ...failure }
    }
    const retryUrl = endpoints.fallback ?? endpoints.primary
    return submitFeedbackWithoutDiagnosticBundle(retryUrl, bodyWithoutDiagnosticBundle, failure)
  }
}

export async function submitFeedback(
  args: InternalFeedbackSubmitArgs,
  env: NodeJS.ProcessEnv = process.env
): Promise<FeedbackSubmitResult> {
  const endpoints = getFeedbackApiEndpoints(env)
  if (!endpoints) {
    return {
      ok: false,
      status: null,
      error: 'Feedback is not configured. Set BOTMUX_FEEDBACK_API_URL.'
    }
  }

  const body = buildSubmitBody(args)
  if (body.diagnosticBundle) {
    const bodyWithoutDiagnosticBundle =
      args.feedbackWithoutDiagnosticBundle !== undefined
        ? buildSubmitBody({
            ...args,
            feedback: args.feedbackWithoutDiagnosticBundle,
            diagnosticBundle: undefined
          })
        : null
    return submitFeedbackWithDiagnosticBundle(body, bodyWithoutDiagnosticBundle, endpoints)
  }
  try {
    const res = await postFeedback(endpoints.primary, body)
    if (res.ok) {
      return { ok: true }
    }
    // Why: optional fallback host for 5xx / missing primary route.
    if ((res.status === 404 || res.status >= 500) && endpoints.fallback) {
      return submitFallbackFeedback(body, endpoints.fallback)
    }
    return { ok: false, status: res.status, error: `status ${res.status}` }
  } catch (error) {
    // Why: falling back on network-level failure when a fallback URL is set.
    return submitFallbackFeedback(body, endpoints.fallback, error)
  }
}

export function registerFeedbackHandlers(): void {
  ipcMain.removeHandler('feedback:submit')
  ipcMain.handle('feedback:submit', (_event, args: FeedbackSubmitArgs) =>
    // Why: crash submissions are main-only. A compromised renderer can invoke
    // this channel directly, so force the public feedback lane at the boundary.
    submitFeedback({ ...args, submissionType: 'feedback' })
  )
}
