import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotRow, DeliveryMode, NativeSkillGroup, ProjectTrustMode, SkillPackRow, SkillRow } from './types.js';

export interface SkillsData {
  skills: SkillRow[];
  nativeSkillGroups: NativeSkillGroup[];
  bots: BotRow[];
  /** full pack rows from /api/skill-packs — the single source for pack state */
  packs: SkillPackRow[];
  trustProjectSkills: ProjectTrustMode;
  delivery: DeliveryMode;
  loading: boolean;
  loadError: string | null;
  /** non-404 failure loading /api/skill-packs — previous pack data is kept */
  packsError: string | null;
  /** true once /api/skill-packs has answered definitively (2xx or 404).
   * While false, pack-derived health is UNKNOWN: consumers must not render
   * pack_missing (nor "healthy") from a never-loaded empty array. */
  packsKnown: boolean;
  refresh: () => Promise<void>;
  /** targeted mutators for optimistic local updates after PUT/DELETE responses */
  setSkills: React.Dispatch<React.SetStateAction<SkillRow[]>>;
  setBots: React.Dispatch<React.SetStateAction<BotRow[]>>;
  setTrustProjectSkills: React.Dispatch<React.SetStateAction<ProjectTrustMode>>;
  setDelivery: React.Dispatch<React.SetStateAction<DeliveryMode>>;
}

/** Single fetch + refresh cycle for the whole skills page. All four tabs read
 * from this state; no tab issues its own list fetch, so there is exactly one
 * copy of skills/packs/bots and one refresh() that keeps them consistent. */
export function useSkillsData(options: { apiUnavailableText: string }): SkillsData {
  const mountedRef = useRef(true);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [nativeSkillGroups, setNativeSkillGroups] = useState<NativeSkillGroup[]>([]);
  const [bots, setBots] = useState<BotRow[]>([]);
  const [packs, setPacks] = useState<SkillPackRow[]>([]);
  const [trustProjectSkills, setTrustProjectSkills] = useState<ProjectTrustMode>('off');
  const [delivery, setDelivery] = useState<DeliveryMode>('auto');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  const [packsKnown, setPacksKnown] = useState(false);
  const apiUnavailableTextRef = useRef(options.apiUnavailableText);
  apiUnavailableTextRef.current = options.apiUnavailableText;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [skillsRes, botsRes, packsRes] = await Promise.all([
        fetch('/api/skills'),
        fetch('/api/bots'),
        // Older daemons may not expose skill packs; treat that as "no packs".
        fetch('/api/skill-packs').catch(() => null),
      ]);
      const skillsBody = await skillsRes.json().catch(() => ({}));
      const botsBody = await botsRes.json().catch(() => ({}));
      const packsBody = packsRes ? await packsRes.json().catch(() => ({})) : {};
      if (!skillsRes.ok) {
        const error = skillsBody?.error ?? `skills HTTP ${skillsRes.status}`;
        throw new Error(error === 'not_found_yet' || error === 'not_found' ? apiUnavailableTextRef.current : error);
      }
      if (!botsRes.ok) throw new Error(botsBody?.error ?? `bots HTTP ${botsRes.status}`);
      if (!mountedRef.current) return;
      setSkills(Array.isArray(skillsBody.skills) ? skillsBody.skills as SkillRow[] : []);
      setNativeSkillGroups(Array.isArray(skillsBody.nativeSkillGroups) ? skillsBody.nativeSkillGroups as NativeSkillGroup[] : []);
      setBots(Array.isArray(botsBody.bots) ? botsBody.bots as BotRow[] : []);
      // Pack failure semantics: only an explicit 404 (older daemon without the
      // pack API) means "no packs". Any other failure (network, 401/403, 5xx)
      // keeps the previous pack data and surfaces packsError — otherwise the
      // graph would misreport every `pack:` reference as pack_missing.
      if (packsRes?.ok && Array.isArray(packsBody.packs)) {
        setPacks(packsBody.packs as SkillPackRow[]);
        setPacksError(null);
        setPacksKnown(true);
      } else if (packsRes?.status === 404) {
        setPacks([]);
        setPacksError(null);
        setPacksKnown(true);
      } else {
        // packsKnown deliberately untouched: false if packs never loaded (first
        // request failed → health must read "unknown"), true if a refresh
        // failed after a successful load (previous data stays authoritative).
        setPacksError(packsRes ? (packsBody?.error ?? `HTTP ${packsRes.status}`) : 'network_error');
      }
      setTrustProjectSkills(skillsBody.trustProjectSkills === 'all' ? 'all' : 'off');
      setDelivery(skillsBody.delivery === 'prompt' || skillsBody.delivery === 'native' ? skillsBody.delivery : 'auto');
      setLoadError(null);
    } catch (err: any) {
      if (mountedRef.current) setLoadError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  return {
    skills, nativeSkillGroups, bots, packs, trustProjectSkills, delivery,
    loading, loadError, packsError, packsKnown, refresh,
    setSkills, setBots, setTrustProjectSkills, setDelivery,
  };
}
