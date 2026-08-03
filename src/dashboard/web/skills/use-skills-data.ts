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
      setPacks(packsRes?.ok && Array.isArray(packsBody.packs) ? packsBody.packs as SkillPackRow[] : []);
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
    loading, loadError, refresh,
    setSkills, setBots, setTrustProjectSkills, setDelivery,
  };
}
