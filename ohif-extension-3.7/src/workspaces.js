import { createElement as h, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LisfrancPanel } from '../workspaces/clinical/panel.js';

const DEMO_URL = new URL('../workspaces/demo/Lisfranc-Review.html', import.meta.url);
const CLINICAL_SIGN_IN = '/api/lisfranc-clinical/v1/sign-in';
const workspaceStyle = {
  height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
};
const tabListStyle = {
  display: 'flex', gap: 4, padding: '8px 12px', flexShrink: 0, borderBottom: '1px solid #354b5f',
};
const buttonStyle = {
  border: '1px solid #527089', borderRadius: 4, padding: '6px 12px',
  color: '#e5eef6', background: '#162735', fontWeight: 600,
};
const dialogStyle = {
  position: 'fixed', inset: 0, margin: 0, padding: 0, border: 0,
  width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none',
  background: '#101820', color: '#e5eef6',
};
const demoBarStyle = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px',
  background: '#162735', borderBottom: '1px solid #354b5f',
};

let nextWorkspaceId = 0;

export function LisfrancWorkspaces({ cornerstone, services }) {
  const [id] = useState(() => 'lisfranc-workspace-' + ++nextWorkspaceId);
  const dialog = useRef(null);
  const clinicalTab = useRef(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoStarted, setDemoStarted] = useState(false);
  const [clinicalStarted, setClinicalStarted] = useState(false);

  function openDemo() {
    if (dialog.current.open) return;
    setDemoStarted(true);
    dialog.current.showModal();
    setDemoOpen(true);
  }

  function closeDemo() {
    dialog.current.close();
  }

  function restoreClinicalFocus() {
    setDemoOpen(false);
    clinicalTab.current?.focus();
  }

  function switchWorkspace(event) {
    if (event.key === 'ArrowRight' || event.key === 'End') {
      event.preventDefault();
      openDemo();
    } else if (event.key === 'ArrowLeft' || event.key === 'Home') {
      event.preventDefault();
      clinicalTab.current?.focus();
    }
  }

  return h('div', { style: workspaceStyle },
    h('div', { role: 'tablist', 'aria-label': 'Lisfranc workspace', style: tabListStyle, onKeyDown: switchWorkspace },
      h('button', {
        id: `${id}-clinical-tab`, type: 'button', role: 'tab', ref: clinicalTab,
        'aria-selected': !demoOpen, 'aria-controls': `${id}-clinical-panel`,
        tabIndex: demoOpen ? -1 : 0, style: { ...buttonStyle, background: '#245777' },
      }, 'Clinical'),
      h('button', {
        id: `${id}-demo-tab`, type: 'button', role: 'tab', onClick: openDemo,
        'aria-selected': demoOpen, 'aria-controls': `${id}-demo-panel`,
        tabIndex: demoOpen ? 0 : -1, style: buttonStyle,
      }, 'Demo')),
    h('div', {
      id: `${id}-clinical-panel`, role: 'tabpanel', 'aria-labelledby': `${id}-clinical-tab`,
      style: { flex: 1, minHeight: 0, overflow: 'auto' },
    }, clinicalStarted
      ? h(LisfrancPanel, { cornerstone, services, paused: demoOpen })
      : h('div', { style: { display: 'grid', gap: 10, padding: 12 } },
        h('p', null, 'Review enrolled studies with your team.'),
        h('button', {
          type: 'button', style: buttonStyle, onClick: () => setClinicalStarted(true),
        }, 'Open Clinical reviews'),
        h('a', {
          href: CLINICAL_SIGN_IN, target: '_blank', rel: 'noopener', style: { color: '#a9d7ff' },
        }, 'Sign in to Clinical'))),
    createPortal(h('dialog', {
      id: `${id}-demo-panel`, ref: dialog, style: dialogStyle, onClose: restoreClinicalFocus,
      'aria-label': 'Demo workspace',
    }, demoStarted && h('div', { style: workspaceStyle },
      h('header', { style: demoBarStyle },
        h('button', { type: 'button', onClick: closeDemo, style: buttonStyle }, 'Back to Clinical'),
        h('strong', null, 'Demo workspace'),
        h('a', {
          href: DEMO_URL.href, target: '_blank', rel: 'noopener',
          style: { marginInlineStart: 'auto', color: '#a9d7ff' },
        }, 'Open demo in a new tab')),
      h('iframe', {
        src: DEMO_URL.href, title: 'Lisfranc demo review',
        style: { width: '100%', flex: 1, minHeight: 0, display: 'block', border: 0 },
      }))), document.body),
  );
}
