import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Destiny Farm Finder',
  description: 'Real-time raid completion leaderboards and active session tracking for Destiny 2',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-900 text-white min-h-screen">
        <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <a href="/" className="text-lg font-bold text-white hover:text-blue-400 transition-colors">
              Destiny Farm Finder
            </a>
            <div className="flex gap-6">
              <a
                href="/leaderboard"
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                Leaderboard
              </a>
              <a
                href="/active-sessions"
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                Active Sessions
              </a>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
