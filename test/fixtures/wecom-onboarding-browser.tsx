import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BotOnboardingDialog, OPEN_BOT_ONBOARDING_EVENT} from '../../src/dashboard/web/bot-onboarding.js';
import {BotDefaultsPage} from '../../src/dashboard/web/bot-defaults-page.js';
import {publishProviderRoster} from '../../src/dashboard/web/provider-roster.js';
publishProviderRoster('lark', 0);
publishProviderRoster('wecom', 1);
function Fixture() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listener = () => setOpen(true);
    window.addEventListener(OPEN_BOT_ONBOARDING_EVENT, listener);
    return () => window.removeEventListener(OPEN_BOT_ONBOARDING_EVENT, listener);
  }, []);
  return <main style={{padding:24}}><BotDefaultsPage /><BotOnboardingDialog open={open} onClose={() => setOpen(false)} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
