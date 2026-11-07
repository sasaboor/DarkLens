import { useEffect, useRef, useState } from 'react';
import { CATEGORIES } from '@/src/core/categories';
import { THRESHOLD_MAX, THRESHOLD_MIN, THRESHOLD_STEP } from '@/src/core/prefs';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Settings } from '@/src/settings';
import { clearStoredData } from '@/src/storage';
import { CategoryDot, Logo, Switch } from '@/src/ui/components';

const DETECTED = CATEGORIES.filter((c) => c.id !== 0);
const VERSION = browser.runtime.getManifest().version;

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    void loadSettings().then(setSettings);
    // Stay in step with changes made elsewhere (the popup's highlights switch, another device).
    return onSettingsChanged(setSettings);
  }, []);

  async function set(patch: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...patch }));
    setSettings(await saveSettings(patch));
  }

  function toggleCategory(id: number, on: boolean) {
    const disabled = on ? settings.disabled.filter((d) => d !== id) : [...settings.disabled, id];
    void set({ disabled });
  }

  async function clearData() {
    if (!confirmClear) {
      setConfirmClear(true);
      setCleared(false);
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setConfirmClear(false), 5000);
      return;
    }
    clearTimeout(clearTimer.current);
    await clearStoredData();
    setConfirmClear(false);
    setCleared(true);
  }

  const off = new Set(settings.disabled);

  return (
    <main className="options">
      <header>
        <Logo />
        <h1>Settings</h1>
        <p className="muted">Changes apply right away on open pages. No reload needed.</p>
      </header>

      <section className="section" aria-labelledby="h-detect">
        <div className="section-head">
          <h2 id="h-detect">Dark patterns to detect</h2>
          {off.size > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => void set({ disabled: [] })}>
              Turn all on
            </button>
          )}
        </div>
        <p className="section-intro">
          The 11 categories from India's CCPA Guidelines for Prevention and Regulation of Dark Patterns (2023) that DarkLens
          checks for. Turned-off categories are not highlighted or counted in the score.
        </p>
        <div className="rows">
          {DETECTED.map((c) => (
            <Switch
              key={c.id}
              leading={<CategoryDot category={c} />}
              checked={!off.has(c.id)}
              onChange={(on) => toggleCategory(c.id, on)}
              label={c.name}
              help={c.description}
              testId={`category-${c.label}`}
            />
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="h-sens">
        <div className="section-head">
          <h2 id="h-sens">
            <label htmlFor="threshold">Sensitivity</label>
          </h2>
          <output className="slider-value" htmlFor="threshold" data-testid="threshold-value">
            {settings.threshold.toFixed(2)}
          </output>
        </div>
        <p className="section-intro">
          The lowest confidence a finding needs before it is shown. Findings with hard evidence (an add-on ticked for you,
          a price that grew at checkout, a timer that resets, a pop-up you cannot close) are always shown.
        </p>
        <input
          id="threshold"
          className="slider"
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={THRESHOLD_STEP}
          value={settings.threshold}
          onChange={(e) => void set({ threshold: Number(e.target.value) })}
          aria-describedby="threshold-ends"
        />
        <div className="slider-ends" id="threshold-ends">
          <span>{THRESHOLD_MIN.toFixed(2)}: more findings</span>
          <span>fewer, surer findings: {THRESHOLD_MAX.toFixed(2)}</span>
        </div>
      </section>

      <section className="section" aria-labelledby="h-scan">
        <h2 id="h-scan" className="section-head">
          Scanning
        </h2>
        <div className="segmented" role="radiogroup" aria-labelledby="h-scan">
          <label>
            <input type="radio" name="scan-mode" checked={settings.autoScan} onChange={() => void set({ autoScan: true })} />
            Automatic
          </label>
          <label>
            <input type="radio" name="scan-mode" checked={!settings.autoScan} onChange={() => void set({ autoScan: false })} />
            Manual
          </label>
        </div>
        <p className="section-intro">
          {settings.autoScan
            ? 'Every page is scanned when it loads, and again when a pop-up or new content appears.'
            : 'Pages are scanned only when you press Rescan in the popup or side panel.'}
        </p>
        <div className="rows">
          <Switch
            checked={settings.highlights}
            onChange={(on) => void set({ highlights: on })}
            label="Highlights on page"
            help="Outline each dark pattern on the page with a badge and an explanation."
          />
        </div>
      </section>

      <section className="section" aria-labelledby="h-adv">
        <h2 id="h-adv" className="section-head">
          Advanced
        </h2>
        <div className="rows">
          <Switch
            checked={settings.debug}
            onChange={(on) => void set({ debug: on })}
            label="Debug logging"
            help="Print the candidate and findings tables to the page console after each scan."
            testId="debug"
          />
          <Switch
            checked={settings.labelling}
            onChange={(on) => void set({ labelling: on })}
            label="Labelling mode"
            help="For building the training set. Hand-labelling tools arrive in a later version; labels stay on this device."
            testId="labelling"
          />
        </div>
      </section>

      <section className="section" aria-labelledby="h-data">
        <h2 id="h-data" className="section-head">
          Stored data
        </h2>
        <p className="section-intro">
          To spot timers that reset and prices that change, DarkLens remembers timer end times, stock counts and prices
          on this device for up to 7 days, plus the findings you marked "Not a dark pattern". It never stores anything you
          type.
        </p>
        <button type="button" className={`btn${confirmClear ? ' btn-danger' : ''}`} onClick={() => void clearData()}>
          {confirmClear ? 'Click again to clear' : 'Clear stored data'}
        </button>
        <span className="inline-status" role="status">
          {cleared ? 'Stored data cleared.' : ''}
        </span>
      </section>

      <section className="section" aria-labelledby="h-about">
        <h2 id="h-about" className="section-head">
          About DarkLens
        </h2>
        <div className="prose">
          <div className="privacy">
            <ShieldIcon />
            <p>
              <strong>Everything runs on your device. Nothing is sent anywhere.</strong> No account, no analytics, no
              remote servers. All detection runs inside the extension.
            </p>
          </div>
          <p>
            To measure colours and contrast accurately, DarkLens takes a screenshot of the visible part of the page
            after a scan. It looks only at the buttons, labels and prices it found (never at text fields), keeps the
            screenshot in memory for a moment, and then discards it. Screenshots are never saved or sent.
          </p>
          <p>
            DarkLens finds dark patterns on Indian shopping sites, highlights them on the page with a plain-English
            reason, and gives each page a risk score from 0 to 100. It covers 11 of the 13 categories in the CCPA
            Guidelines for Prevention and Regulation of Dark Patterns (notified 30 November 2023):
          </p>
          <ul className="cat-grid" aria-label="Categories covered">
            {DETECTED.map((c) => (
              <li key={c.id}>
                <CategoryDot category={c} />
                {c.name}
              </li>
            ))}
          </ul>
          <p>
            <strong>Out of scope:</strong> SaaS billing and rogue malware. These happen in billing systems and installed
            software, not on a shopping page, so a page scanner cannot see them.
          </p>
          <p>
            DarkLens points out likely dark patterns; it is not legal advice. If a finding is wrong, use "Not a dark
            pattern?" in its tooltip.
          </p>
          <p className="small">Version {VERSION}</p>
        </div>
      </section>
    </main>
  );
}
