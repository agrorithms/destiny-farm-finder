import type { Metadata } from 'next';

// The pasted direct link is this page's entire distribution channel — nothing on the
// site links to it (unlisted, not private: see ADR 0007 / issue #76 D7) — so the unfurl
// matters more here than on any other route. Inheriting the site-wide metadata would
// make a shared link unfurl identically to the homepage, which defeats sharing it.
const title = 'The GoS 10k — Destiny Farm Finder';
const description =
    '10,000 Garden of Salvation full clears by one Guardian, and the 5,455 people who helped. '
    + 'A complete, frozen archive of every run from 2020 to 2026.';

export const metadata: Metadata = {
    title,
    description,
    openGraph: { title, description },
    twitter: { card: 'summary_large_image', title, description },
};

export default function Gos10kLayout({ children }: { children: React.ReactNode }) {
    return children;
}
