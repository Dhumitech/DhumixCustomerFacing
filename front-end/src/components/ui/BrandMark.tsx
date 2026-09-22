interface BrandMarkProps {
  readonly compact?: boolean;
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <span className="brand-mark">
      <img
        className="brand-mark__logo"
        src="/brand/dhumi-logo.png"
        alt="Dhumi"
      />
      {!compact && <span className="brand-mark__product">Data Scrappers</span>}
    </span>
  );
}
