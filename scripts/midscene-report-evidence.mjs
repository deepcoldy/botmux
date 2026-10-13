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

function screenshotForStep(step, data) {
  const candidates = [];
  for (const detail of step?.agentDetails ?? []) {
    const execution = executionForDetail(data.dumps, detail);
    for (const task of execution?.tasks ?? []) {
      const screenshotId = task?.uiContext?.screenshot?.id;
      if (screenshotId && data.images.has(screenshotId)) candidates.push(screenshotId);
    }
  }
  const selected = candidates.at(-1);
  return selected ? data.images.get(selected) : null;
}

function projectSlug(projectName) {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function reportCases(run, projectName, { html, reportFile }) {
  const project = run?.projects?.find((candidate) => candidate.name === projectName);
  if (!project) throw new Error(`Project ${projectName} is absent from the report`);
  const data = await reportData(html, reportFile);
  return (project.documents ?? []).flatMap((document) =>
    (document.cases ?? []).map((testCase) => {
      const attempt = testCase.attempts?.at(-1);
      const steps = allAttemptSteps(attempt);
      const passed = (testCase.status ?? attempt?.status) === 'success';
      const step = passed
        ? steps.findLast(hasAgentEvidence) ?? steps.at(-1)
        : steps.find((candidate) => candidate.status === 'failed' && hasAgentEvidence(candidate)) ??
          steps.find((candidate) => candidate.status === 'failed') ??
          steps.at(-1);
      const screenshot = screenshotForStep(step, data);
      const extension = screenshot?.extension ?? 'jpg';
      return {
        caseId: testCase.caseId,
        name: testCase.name,
        project: projectName,
        status: passed ? 'success' : testCase.status ?? attempt?.status ?? 'failed',
        durationMs: attempt?.durationMs,
        attempts: testCase.attempts?.length ?? 0,
        stepId: step?.id ?? null,
        previewFile: screenshot
          ? `case-preview-${projectSlug(projectName)}-${testCase.caseId}.${extension}`
          : null,
        screenshot,
      };
    }),
  );
}
