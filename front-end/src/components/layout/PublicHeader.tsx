import { BrandMark } from "../ui/BrandMark";

const navigation = [
  { label: "Scrapers", href: "/#scrapers" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Why Dhumi", href: "/#contact" },
  { label: "Price analysis", href: "/analysis" },
];

interface PublicHeaderProps {
  readonly isAuthenticated: boolean;
  readonly onLogin: () => void;
}

export function PublicHeader({ isAuthenticated, onLogin }: PublicHeaderProps) {
  return (
    <header className="public-header">
      <a className="brand-link" href="/" aria-label="Dhumi Data Scrappers home">
        <BrandMark />
      </a>

      <nav className="public-navigation" aria-label="Primary navigation">
        {navigation.map((item) => (
          <a key={item.href} href={item.href}>
            {item.label}
          </a>
        ))}
      </nav>

      <div className="header-actions">
        {isAuthenticated ? (
          <span className="header-session-state">
            <span className="header-session-state__mark" aria-hidden="true">
              ✓
            </span>
            Signed in
          </span>
        ) : (
          <button className="header-cta" type="button" onClick={onLogin}>
            Login
          </button>
        )}
      </div>
    </header>
  );
}
