import { useCallback, useState } from "react";
import { PublicHeader } from "../../components/layout/PublicHeader";
import { useSession } from "../../session/useSession";
import { AuthDialog, type AuthMode } from "./AuthDialog";

const scraperBenefits = [
  {
    number: "01",
    title: "Ready-made scrapers",
    description:
      "Choose a scraper built for the information you want to collect.",
  },
  {
    number: "02",
    title: "One page or many",
    description:
      "Start with a single page or add a complete list to one collection.",
  },
  {
    number: "03",
    title: "Clear progress",
    description:
      "Follow each collection from the moment it starts until it is ready.",
  },
  {
    number: "04",
    title: "Downloadable results",
    description:
      "Receive structured data that is ready for your everyday workflow.",
  },
];

const collectionSteps = [
  {
    number: "01",
    title: "Enter your workspace",
    description: "Sign in and keep your collections together in one place.",
  },
  {
    number: "02",
    title: "Choose a scraper",
    description: "Pick the ready-made scraper that matches what you need.",
  },
  {
    number: "03",
    title: "Add your pages",
    description: "Paste one page or a list, then start your collection.",
  },
  {
    number: "04",
    title: "Follow and download",
    description: "See progress clearly and download the finished data.",
  },
];

interface WelcomePageProps {
  readonly initialAuthMode?: AuthMode | null;
}

export function WelcomePage({ initialAuthMode = null }: WelcomePageProps) {
  const [authMode, setAuthMode] = useState<AuthMode | null>(initialAuthMode);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const { isAuthenticated } = useSession();

  const closeAuth = useCallback(() => {
    setAuthMode(null);

    if (
      window.location.pathname === "/sign-up" ||
      window.location.pathname === "/sign-in"
    ) {
      window.history.replaceState(null, "", "/");
    }
  }, []);

  function changeAuthMode(mode: AuthMode) {
    setAuthMode(mode);
  }

  function handleAuthenticated(): void {
    closeAuth();
    setSessionNotice("You’re signed in. Your Dhumi workspace is ready.");
  }

  return (
    <div className="welcome-page">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <PublicHeader
        isAuthenticated={isAuthenticated}
        onLogin={() => setAuthMode("sign-in")}
      />

      {sessionNotice && (
        <div className="session-notice" role="status">
          <span>{sessionNotice}</span>
          <button
            type="button"
            aria-label="Dismiss sign-in confirmation"
            onClick={() => setSessionNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__accent hero__accent--left" aria-hidden="true" />
          <div
            className="hero__accent hero__accent--right"
            aria-hidden="true"
          />

          <p className="hero-kicker">Your data, ready to use</p>

          <h1 id="hero-title">
            Turn web pages into
            <span className="hero-title__highlight">
              useful, structured data.
            </span>
          </h1>

          <p className="hero-summary">
            Choose a ready-made scraper, add the pages you want to collect, and
            let Dhumi deliver clean results you can follow and download from one
            simple workspace.
          </p>

          <div className="hero-actions">
            <button
              className="button button--primary"
              type="button"
              onClick={() => setAuthMode("sign-up")}
            >
              Start collecting
              <span aria-hidden="true">→</span>
            </button>
            <a className="button button--secondary" href="#contact">
              Talk to our experts
            </a>
          </div>

          <p className="hero-assurance">
            <span>Simple setup</span>
            <span aria-hidden="true">•</span>
            <span>Clear progress</span>
            <span aria-hidden="true">•</span>
            <span>Results ready to download</span>
          </p>
        </section>

        <section
          className="benefit-strip"
          id="scrapers"
          aria-label="What you can do with Dhumi"
        >
          {scraperBenefits.map((benefit) => (
            <article key={benefit.number} className="benefit">
              <span className="benefit__number">{benefit.number}</span>
              <h2>{benefit.title}</h2>
              <p>{benefit.description}</p>
            </article>
          ))}
        </section>

        <section
          className="workflow"
          id="how-it-works"
          aria-labelledby="workflow-title"
        >
          <div className="workflow__heading">
            <p className="section-eyebrow">How it works</p>
            <h2 id="workflow-title">From a page to a result in four steps.</h2>
          </div>

          <ol className="workflow__steps">
            {collectionSteps.map((step) => (
              <li key={step.number}>
                <span>{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className="customer-promise"
          id="contact"
          aria-labelledby="promise-title"
        >
          <div className="customer-promise__mark" aria-hidden="true">
            D
          </div>
          <div className="customer-promise__copy">
            <p className="section-eyebrow">Built around your work</p>
            <h2 id="promise-title">Less setup. More usable data.</h2>
            <p>
              Keep your scrapers, collections, progress, and downloads in one
              place—ready whenever your team needs them.
            </p>
          </div>
          <button
            className="button button--dark"
            type="button"
            onClick={() => setAuthMode("sign-up")}
          >
            Create your workspace
            <span aria-hidden="true">→</span>
          </button>
        </section>
      </main>

      <footer className="public-footer">
        <span>Dhumi Data Scrappers</span>
        <span>Structured data, without the busywork.</span>
      </footer>

      {authMode && (
        <AuthDialog
          mode={authMode}
          onClose={closeAuth}
          onModeChange={changeAuthMode}
          onAuthenticated={handleAuthenticated}
        />
      )}
    </div>
  );
}
