import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import Script from 'next/script';
import packageJson from '../../package.json';
import './globals.css';
import PlayerSearch from '@/components/PlayerSearch';
import StatsBar from '@/components/StatsBar';
import ThemeToggle from '@/components/ThemeToggle';
import BungieMaintenanceAlert from '@/components/BungieMaintenanceAlert';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://destinyfarmfinder.qzz.io';

export const metadata: Metadata = {
  // Required so relative og:image URLs (from opengraph-image.tsx) resolve to absolute URLs,
  // which social crawlers (Discord/Slack/Twitter) require.
  metadataBase: new URL(siteUrl),
  title: 'Destiny Farm Finder',
  description: 'Real-time raid completion leaderboards and active session tracking for Destiny 2',
  manifest: '/manifest.json',
  icons: {
    apple: '/icons/apple-touch-icon.png',
  },
  openGraph: {
    title: 'Destiny Farm Finder',
    description: 'Real-time raid completion leaderboards and active session tracking for Destiny 2',
    siteName: 'Destiny Farm Finder',
    url: siteUrl,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Destiny Farm Finder',
    description: 'Real-time raid completion leaderboards and active session tracking for Destiny 2',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets .dark before paint (localStorage override, else OS preference) so
            there is no flash of the wrong theme. Kept in sync by useTheme afterwards. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('destiny-farm-finder-theme');if(t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}`,
          }}
        />
        <Script
          src="https://cloud.umami.is/script.js"
          data-website-id="ac99ded7-08b1-405d-9438-b3e03c1a7339"
          strategy="afterInteractive"
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"></link>
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"></link>
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"></link>
        <link rel="manifest" href="/manifest.json"></link>
      </head>
      <body className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex flex-col">
        <nav className="ui-nav-surface border-b backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 py-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-8">
            <div className="flex items-center gap-3 lg:gap-6 min-w-0 lg:flex-1">
              <Link href="/" className="text-base lg:text-lg font-bold ui-text-primary hover:text-[var(--ui-accent)] transition-colors shrink-0">
                Destiny Farm Finder
              </Link>
              <div className="w-full min-w-0 max-w-md">
                <PlayerSearch />
              </div>
            </div>
            <div className="flex items-center justify-between lg:justify-end lg:gap-6 shrink-0">
              <div className="flex gap-6">
                <Link
                  href="/leaderboard"
                  className="text-sm ui-text-secondary hover:text-[var(--ui-text-primary)] transition-colors"
                >
                  Leaderboard
                </Link>
                <Link
                  href="/active-sessions"
                  className="text-sm ui-text-secondary hover:text-[var(--ui-text-primary)] transition-colors"
                >
                  Active Sessions
                </Link>
              </div>
              <ThemeToggle />
            </div>
          </div>
          <StatsBar />
        </nav>
        <BungieMaintenanceAlert />
        <main className="max-w-7xl mx-auto px-4 py-6 w-full flex-1">
          {children}
        </main>
        <footer className="ui-footer-surface border-t mt-8">
          <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="ui-text-muted">Version v{packageJson.version}</span>
              <span className="ui-text-subtle" aria-hidden="true">•</span>
              <Link href="/changelog" className="ui-footer-link">
                Changelog
              </Link>
              <span className="ui-text-subtle" aria-hidden="true">•</span>
              <Link href="/about" className="ui-footer-link">
                About
              </Link>
              <span className="ui-text-subtle" aria-hidden="true">•</span>
              <Link href="/faq" className="ui-footer-link">
                FAQ
              </Link>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <a
                href="https://ko-fi.com/destinyfarmfinder"
                target="_blank"
                rel="noopener noreferrer"
                className="ui-footer-icon-link"
                aria-label="Support Destiny Farm Finder on Ko-fi"
                title="Ko-fi"
              >
                <Image src="https://ko-fi.com/img/favicon.ico" alt="" width={18} height={18} />
              </a>
              <a
                href="https://discord.gg/DndgAEqcEQ"
                target="_blank"
                rel="noopener noreferrer"
                className="ui-footer-icon-link"
                aria-label="Join the Destiny Farm Finder Discord"
                title="Discord"
              >
                <Image src="https://discord.com/assets/favicon.ico" alt="" width={18} height={18} />
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
