import { useState } from 'react';
import type { Banner } from './api';
import { useFrameState } from './store';

function BannerView({ banner }: { banner: Banner }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const heading = `banner-${banner.id}`;
  return (
    <section className={`frame-banner frame-banner-${banner.tone}`} aria-labelledby={heading}>
      <h2 id={heading}>{banner.title}</h2>
      {banner.body && <p>{banner.body}</p>}
      {banner.actions && banner.actions.length > 0 && (
        <div className="frame-banner-actions">
          {banner.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void Promise.resolve(action.run()).finally(() => setBusy(false));
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The banners above the editor. They are not alerts: the store says each
 * banner's title once through the window's polite live region instead.
 */
export function Banners(): JSX.Element | null {
  const { banners } = useFrameState();
  if (banners.length === 0) return null;
  return (
    <div className="frame-banners">
      {banners.map((banner) => <BannerView key={banner.id} banner={banner} />)}
    </div>
  );
}
