import { useState } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Button, Icon, type IconComponent } from '@ordewell/ui/design';
import type { Banner } from './api';
import { useFrameState } from './store';

const TONE_ICONS: Readonly<Record<Banner['tone'], IconComponent>> = {
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
};

function BannerView({ banner }: { banner: Banner }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const heading = `banner-${banner.id}`;
  return (
    <section className={`frame-banner frame-banner-${banner.tone}`} aria-labelledby={heading}>
      <Icon icon={TONE_ICONS[banner.tone]} size={16} className="frame-banner-icon" />
      <div className="frame-banner-text">
        <h2 id={heading}>{banner.title}</h2>
        {banner.body && <p>{banner.body}</p>}
      </div>
      {banner.actions && banner.actions.length > 0 && (
        <div className="frame-banner-actions">
          {banner.actions.map((action) => (
            <Button
              key={action.label}
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void Promise.resolve(action.run()).finally(() => setBusy(false));
              }}
            >
              {action.label}
            </Button>
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
