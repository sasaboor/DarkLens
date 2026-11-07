import { useEffect, useState } from 'react';
import { CATEGORIES } from '@/src/core/categories';
import { loadSettings, onSettingsChanged, saveSettings } from '@/src/settings';
import { CategoryChip, Logo, PAGE_TYPE_LABEL, ScoreDial, Switch, riskLevel, verdict } from '@/src/ui/components';
import { rescanActiveTab } from '@/src/ui/rescan';
import { isWebPage, useTabReport } from '@/src/ui/useTabReport';

const BUILD = __DARKLENS_BUILD__;

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export default function App() {
  const { tab, setTab, report, loaded } = useTabReport({ followActive: false });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState(true);
  const [autoScan, setAutoScan] = useState(true);

  useEffect(() => {
    void loadSettings().then((s) => {
      setHighlights(s.highlights);
      setAutoScan(s.autoScan);
    });
    return onSettingsChanged((s) => {
      setHighlights(s.highlights);
      setAutoScan(s.autoScan);
    });
  }, []);

  async function rescan() {
    setBusy(true);
    setStatus('Scanning… (about 2 s)');
    const outcome = await rescanActiveTab();
    if (outcome.tab && outcome.tab.id !== tab?.id) setTab(outcome.tab);
    setStatus(outcome.message);
    setBusy(false);
  }

  function openDetails() {
    if (!tab) return;
    // Called straight from the click so Chrome still sees the user gesture.
    browser.sidePanel
      .open({ windowId: tab.windowId })
      .then(() => window.close())
      .catch((err: unknown) => setStatus(`Could not open the side panel: ${String(err)}`));
  }

  async function toggleHighlights(on: boolean) {
    setHighlights(on);
    await saveSettings({ highlights: on });
  }

  const counts = new Map<number, number>();
  for (const f of report?.findings ?? []) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const web = isWebPage(report?.url ?? tab?.url ?? '');
  const level = report ? riskLevel(report.score) : null;

  return (
    <main className="popup">
      <div className="topbar">
        <Logo />
        <button type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={() => void browser.runtime.openOptionsPage()}>
          <GearIcon />
        </button>
      </div>

      {report && level ? (
        <section aria-label="Risk summary" className="summary">
          <ScoreDial score={report.score} />
          <div>
            <h1 className="verdict">
              <span className="visually-hidden">Result: </span>
              {verdict(report.findings.length)}
              <span hidden data-testid="count">
                {report.findings.length}
              </span>
            </h1>
            <p className="risk-line">
              <span className="risk-tag" data-tone={level.tone}>
                {level.label}
              </span>
              <span aria-hidden>·</span>
              <span data-testid="page-type">{PAGE_TYPE_LABEL[report.pageType]}</span>
            </p>
          </div>
        </section>
      ) : (
        loaded && (
          <div className="empty">
            {web ? (
              <>
                <strong>No scan yet for this tab</strong>
                {autoScan ? 'Pages are scanned when they finish loading. Press Rescan to scan now.' : 'Auto-scan is off. Press Rescan to scan this page.'}
              </>
            ) : (
              <>
                <strong>Nothing to scan here</strong>
                DarkLens only runs on web pages (http and https).
              </>
            )}
          </div>
        )
      )}

      {report && counts.size > 0 && (
        <ul className="chips" aria-label="Findings by category">
          {CATEGORIES.filter((c) => counts.has(c.id)).map((c) => (
            <CategoryChip key={c.id} category={c} count={counts.get(c.id)!} />
          ))}
        </ul>
      )}

      <div className="actions">
        <button type="button" className="btn" onClick={() => void rescan()} disabled={busy}>
          {busy ? 'Scanning…' : 'Rescan'}
        </button>
        <button type="button" className="btn btn-primary" onClick={openDetails} disabled={!tab}>
          Open details
        </button>
      </div>

      <div className="panel-box">
        <Switch checked={highlights} onChange={(on) => void toggleHighlights(on)} label="Highlights on page" testId="highlights" />
      </div>

      {status && (
        <p className="status" data-testid="status" role="status">
          {status}
        </p>
      )}

      <footer className="footer">
        <span className="model">
          <span className={`status-dot${report?.mode === 'model+rules' ? ' on' : ''}`} aria-hidden />
          <span data-testid="mode">{report?.mode === 'model+rules' ? 'Model + rules' : 'Rules only'}</span>
        </span>
        {report && report.hidden > 0 && (
          <span>
            {report.hidden} more hidden by your settings
          </span>
        )}
        <span className="small" title="Build time">
          build {BUILD}
        </span>
      </footer>
    </main>
  );
}
