import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { CATEGORIES, categoryById } from '@/src/core/categories';
import type { Finding } from '@/src/core/types';
import { FOCUS, type FocusMessage, type FocusReply, type TabReport } from '@/src/messages';
import { Badge, CategoryDot, ConfidenceBar, Logo, PAGE_TYPE_LABEL, SOURCE_LABEL, riskLevel, verdict } from '@/src/ui/components';
import { rescanActiveTab } from '@/src/ui/rescan';
import { isWebPage, useTabReport, type TabInfo } from '@/src/ui/useTabReport';

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function FindingCard({
  finding,
  text,
  gone,
  onShow,
}: {
  finding: Finding;
  text: string | undefined;
  gone: boolean;
  onShow: () => void;
}) {
  const cat = categoryById(finding.category);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onShow();
    }
  };
  return (
    <article
      className="card"
      role="button"
      tabIndex={0}
      aria-label={`${cat.name}: ${finding.reason}. Show on page.`}
      style={{ '--c': cat.color } as CSSProperties}
      onClick={onShow}
      onKeyDown={onKey}
      data-testid="finding-card"
      data-category={cat.label}
    >
      <div className="card-top">
        <span className="card-cat">{cat.name}</span>
        {finding.confirmed && <Badge kind="good">Confirmed</Badge>}
        {finding.hard && <Badge kind="warn">Hard evidence</Badge>}
        <Badge>{SOURCE_LABEL[finding.source]}</Badge>
      </div>
      <p className="card-reason">{finding.reason}</p>
      {text && (
        <p className="card-text">
          <span>“{text}”</span>
        </p>
      )}
      {finding.evidence.length > 0 && (
        <ul className="card-evidence" aria-label="Evidence">
          {finding.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <ConfidenceBar value={finding.confidence} color={cat.color} />
      <p className="card-desc">
        <b>CCPA:</b> {cat.description}
      </p>
      {gone && (
        <p className="card-note" role="status">
          No longer on the page. Rescan to update.
        </p>
      )}
    </article>
  );
}

function Findings({ report, tab }: { report: TabReport; tab: TabInfo }) {
  const [gone, setGone] = useState<Set<string>>(new Set());

  async function show(candidateId: string) {
    const msg: FocusMessage = { type: FOCUS, candidateId };
    const reply = (await browser.tabs.sendMessage(tab.id, msg).catch(() => undefined)) as FocusReply | undefined;
    setGone((prev) => {
      const next = new Set(prev);
      if (reply?.ok) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }

  if (report.findings.length === 0) {
    return (
      <div className="empty">
        <strong>No dark patterns found on this page</strong>
        {report.hidden > 0
          ? `${report.hidden} finding${report.hidden === 1 ? ' is' : 's are'} hidden by your settings.`
          : 'DarkLens checked buttons, choices, prices, timers and pop-ups.'}
      </div>
    );
  }

  const groups = CATEGORIES.map((c) => ({
    category: c,
    findings: report.findings.filter((f) => f.category === c.id).sort((a, b) => b.confidence - a.confidence),
  })).filter((g) => g.findings.length > 0);

  return (
    <>
      {groups.map(({ category, findings }) => (
        <section key={category.id} className="group" aria-label={category.name} data-testid="finding-group">
          <h2 className="group-head">
            <CategoryDot category={category} />
            {category.name}
            <span className="group-count">{findings.length}</span>
          </h2>
          {findings.map((f) => (
            <FindingCard
              key={f.candidateId}
              finding={f}
              text={report.items[f.candidateId]?.text}
              gone={gone.has(f.candidateId)}
              onShow={() => void show(f.candidateId)}
            />
          ))}
        </section>
      ))}
      {report.hidden > 0 && (
        <p className="muted small">
          {report.hidden} more finding{report.hidden === 1 ? '' : 's'} hidden by your settings (category filters or sensitivity).
        </p>
      )}
    </>
  );
}

export default function App() {
  const { tab, setTab, report, loaded } = useTabReport({ followActive: true });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function rescan() {
    setBusy(true);
    setStatus('');
    const outcome = await rescanActiveTab();
    if (outcome.tab && outcome.tab.id !== tab?.id) setTab(outcome.tab);
    if (!outcome.ok) setStatus(outcome.message);
    setBusy(false);
  }

  const url = report?.url ?? tab?.url ?? '';
  const level = report ? riskLevel(report.score) : null;

  return (
    <main className="sidepanel">
      <header className="sp-header">
        <div className="topbar">
          <Logo />
          <button type="button" className="btn btn-sm" onClick={() => void rescan()} disabled={busy || !tab}>
            {busy ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        {report && level && (
          <div className="sp-page">
            <span className="score-pill" data-tone={level.tone} aria-label={`Risk score ${report.score} of 100, ${level.label.toLowerCase()}`}>
              {report.score}
              <small>/100</small>
            </span>
            <div className="sp-page-text">
              <p className="sp-host" title={url}>
                {hostOf(url)}
              </p>
              <p className="muted small">
                {PAGE_TYPE_LABEL[report.pageType]} · {verdict(report.findings.length)} · {level.label}
              </p>
            </div>
          </div>
        )}
        {status && (
          <p className="status" role="status">
            {status}
          </p>
        )}
      </header>
      <div className="sp-body">
        {report && tab ? (
          <Findings key={`${tab.id}:${report.scannedAt}`} report={report} tab={tab} />
        ) : (
          loaded && (
            <div className="empty">
              {isWebPage(url) ? (
                <>
                  <strong>No scan yet for this tab</strong>
                  Press Rescan to check this page for dark patterns.
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
      </div>
    </main>
  );
}
