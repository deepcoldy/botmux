import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function normalizeJsonControlCharacters(source) {
  let normalized = '';
  let insideString = false;
  let escaped = false;
  for (const character of source) {
    if (!insideString) {
      normalized += character;
      if (character === '"') insideString = true;
    } else if (escaped) {
      normalized += character;
      escaped = false;
    } else if (character === '\\') {
      normalized += character;
      escaped = true;
    } else if (character === '"') {
      normalized += character;
      insideString = false;
    } else if (character.charCodeAt(0) <= 0x1f) {
      normalized += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else {
      normalized += character;
    }
  }
  return normalized;
}

export function testRunDump(html) {
  const match = html.match(
    /<script\s+type=["']midscene_test_run_dump["'][^>]*>\s*(\{[\s\S]*?)<\/script>/,
  );
  return match ? JSON.parse(normalizeJsonControlCharacters(match[1])) : null;
}

function scriptAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(/([\w-]+)=["']([^"']*)["']/g)) {
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

async function reportData(html, reportFile) {
  const dumps = [];
  for (const match of html.matchAll(
    /<script\s+([^>]*\btype=["']midscene_web_dump["'][^>]*)>\s*(\{[\s\S]*?)<\/script>/g,
  )) {
    const attributes = scriptAttributes(match[1]);
    dumps.push({
      reportId:
        attributes.get('data-report-id') ??
        attributes.get('data-group-id') ??
        null,
      dump: JSON.parse(normalizeJsonControlCharacters(match[2].trim())),
    });
  }

  const images = new Map();
  for (const match of html.matchAll(
    /<script\s+type=["']midscene-image["']\s+data-id=["']([^"']+)["'][^>]*>\s*data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)\s*<\/script>/g,
  )) {
    images.set(match[1], {
      extension: match[2] === 'jpeg' ? 'jpg' : match[2],
      bytes: Buffer.from(match[3], 'base64'),
    });
  }

  const screenshots = path.join(path.dirname(reportFile), 'screenshots');
  let entries = [];
  try {
    entries = await readdir(screenshots);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const name of entries.sort()) {
    const extension = name.split('.').at(-1)?.toLowerCase();
    const id = name.slice(0, name.lastIndexOf('.'));
    if (!id || !['jpg', 'jpeg', 'png', 'webp'].includes(extension)) continue;
    if (!images.has(id)) {
      images.set(id, {
        extension: extension === 'jpeg' ? 'jpg' : extension,
        bytes: await readFile(path.join(screenshots, name)),
      });
    }
  }
  return { dumps, images };
}

function allAttemptSteps(attempt) {
  return [
    ...(attempt?.beforeEach ?? []),
    ...(attempt?.steps ?? []),
    ...(attempt?.afterEach ?? []),
  ];
}

function hasAgentEvidence(step) {
  return Array.isArray(step?.agentDetails) && step.agentDetails.length > 0;
}

function executionForDetail(dumps, detail) {
  const preferred = dumps.filter(
    (entry) => !detail.reportId || entry.reportId === detail.reportId,
  );
  for (const entry of preferred.length ? preferred : dumps) {
    const execution = entry.dump?.executions?.find(
      (candidate) => candidate.id === detail.executionId,
    );
    if (execution) return execution;
  }
  return null;
}

// Named by the E2E helpers on failure (helpers.ts recordFailureState).
const FAILURE_STATE_MARK = '失败现场';

function taskScreenshotIds(task) {
  const ids = [];
  if (task?.uiContext?.screenshot?.id) ids.push(task.uiContext.screenshot.id);
  // recordToReport() keeps its screenshots on the task recorder.
  for (const item of task?.recorder ?? []) {
    if (item?.screenshot?.id) ids.push(item.screenshot.id);
  }
  return ids;
}

function screenshotForStep(step, data, { failed = false } = {}) {
  const candidates = [];
  const failureCandidates = [];
  for (const detail of step?.agentDetails ?? []) {
    const execution = executionForDetail(data.dumps, detail);
    const isFailureState = failed && String(execution?.name ?? '').includes(FAILURE_STATE_MARK);
    for (const task of execution?.tasks ?? []) {
      for (const screenshotId of taskScreenshotIds(task)) {
        if (!data.images.has(screenshotId)) continue;
        candidates.push(screenshotId);
        if (isFailureState) failureCandidates.push(screenshotId);
      }
    }
  }
  // A failed case's later actions (e.g. restoring a chat mode) would otherwise
  // supply the preview, showing the cleaned-up page instead of the failure.
  const selected = failureCandidates.at(-1) ?? candidates.at(-1);
  return selected ? data.images.get(selected) : null;
}

// Feishu lanes — mirror of test/e2e-browser/lanes.ts (plain .mjs cannot import
// TypeScript; test/midscene-lanes.test.ts keeps the two in step). Every
// cases/*.yaml file is the Midscene project `feishu-<file stem>`; cases that
// never ran have no report, so their project is derived from the YAML path.
function laneStem(file) {
  return path.basename(file).replace(/\.ya?ml$/i, '');
}

export function feishuLaneProject(caseFile) {
  return `feishu-${laneStem(caseFile)}`;
}

export function isFeishuLaneProject(projectName) {
  return typeof projectName === 'string' && projectName.startsWith('feishu-');
}

export function selectFeishuLaneFiles(files, selection) {
  const value = selection?.trim() || 'core';
  if (value === 'all') return [...files];
  if (value === 'core') return files.filter((file) => laneStem(file).startsWith('core-'));
  const wanted = value.split(',').map((stem) => stem.trim()).filter(Boolean);
  const unknown = wanted.filter((stem) => !files.some((file) => laneStem(file) === stem));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown FEISHU_E2E_CASES lane(s): ${unknown.join(', ')}. ` +
        `Known: core, all, ${files.map(laneStem).join(', ')}`,
    );
  }
  return files.filter((file) => wanted.includes(laneStem(file)));
}

/**
 * First line of the failing step's error, without the `Node "x" failed:`
 * wrapper, so a reader sees why a case failed even when no screenshot exists.
 */
export function failureReason(step) {
  const message = step?.error?.message;
  if (typeof message !== 'string' || message.length === 0) return null;
  const reason = message.replace(/^Node "[^"]+" failed:\s*/, '').split('\n')[0].trim();
  return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}

function projectSlug(projectName) {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function reportCases(run, projectNames, { html, reportFile }) {
  const names = Array.isArray(projectNames) ? projectNames : [projectNames];
  const projects = names.map((projectName) => {
    const project = run?.projects?.find((candidate) => candidate.name === projectName);
    if (!project) throw new Error(`Project ${projectName} is absent from the report`);
    return project;
  });
  const data = await reportData(html, reportFile);
  return projects.flatMap((project) => (project.documents ?? []).flatMap((document) =>
    (document.cases ?? []).map((testCase) => {
      const projectName = project.name;
      const attempt = testCase.attempts?.at(-1);
      const steps = allAttemptSteps(attempt);
      const passed = (testCase.status ?? attempt?.status) === 'success';
      const step = passed
        ? steps.findLast(hasAgentEvidence) ?? steps.at(-1)
        : steps.find((candidate) => candidate.status === 'failed' && hasAgentEvidence(candidate)) ??
          steps.find((candidate) => candidate.status === 'failed') ??
          steps.at(-1);
      const screenshot = screenshotForStep(step, data, { failed: !passed });
      const extension = screenshot?.extension ?? 'jpg';
      return {
        caseId: testCase.caseId,
        name: testCase.name,
        project: projectName,
        status: passed ? 'success' : testCase.status ?? attempt?.status ?? 'failed',
        durationMs: attempt?.durationMs,
        attempts: testCase.attempts?.length ?? 0,
        stepId: step?.id ?? null,
        failure: passed ? null : failureReason(step),
        previewFile: screenshot
          ? `case-preview-${projectSlug(projectName)}-${testCase.caseId}.${extension}`
          : null,
        screenshot,
      };
    }),
  ));
}

/**
 * Case results rebuilt from Midscene's per-attempt result files
 * (`<project>/documents/<doc>/cases/<caseId>/<attemptId>.json`). Midscene writes
 * them as each attempt ends, but the HTML report and summary only at the end of
 * the run — so when CI kills a run that hit its time limit, these files are the
 * only record of the cases that did finish. Latest attempt wins.
 */
export async function attemptResultCases(root, projectMatches = () => true) {
  const attempts = new Map();
  async function visit(directory) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json') || !candidate.includes(`${path.sep}cases${path.sep}`)) continue;
      let result;
      try {
        result = JSON.parse(await readFile(candidate, 'utf8'));
      } catch {
        continue;
      }
      if (typeof result?.caseId !== 'string' || typeof result?.attemptId !== 'string') continue;
      if (!projectMatches(result.projectName)) continue;
      const key = `${result.projectName}\0${result.caseId}`;
      const list = attempts.get(key) ?? [];
      list.push(result);
      attempts.set(key, list);
    }
  }
  await visit(root);
  return [...attempts.values()].map((list) => {
    list.sort((left, right) => (left.attemptIndex ?? 0) - (right.attemptIndex ?? 0));
    const latest = list.at(-1);
    const passed = latest.status === 'success';
    const steps = allAttemptSteps(latest);
    const step = passed ? null : steps.find((candidate) => candidate.status === 'failed') ?? steps.at(-1);
    return {
      caseId: latest.caseId,
      name: latest.name,
      project: latest.projectName,
      status: passed ? 'success' : 'failed',
      durationMs: latest.durationMs,
      attempts: list.length,
      stepId: null,
      failure: passed ? null : failureReason(step) ?? latest.executionErrors?.[0]?.message ?? null,
      reportPath: null,
      previewPath: null,
    };
  });
}
