export default function Home() {
  return (
    <div className="space-y-8">
      <div className="text-center py-12">
        <h1 className="text-4xl font-bold mb-4">Destiny Farm Finder</h1>
        <p className="text-gray-600 dark:text-gray-400 text-lg max-w-2xl mx-auto">
          Track who is raiding right now. See real-time leaderboards of
          the most completed raid activities in the past few hours to several days, and browse
          active raid sessions across Destiny 2.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <a
          href="/leaderboard"
          className="block ui-card ui-card-warm-hover p-6 transition-colors group"
        >
          <h2 className="text-xl font-bold mb-2 ui-text-primary group-hover:text-[var(--ui-accent)] transition-colors">
            Leaderboard
          </h2>
          <p className="ui-text-secondary text-sm">
            See which players have completed the most raid clears in the past
            few hours. Filter by raid and adjust the time window.
          </p>
        </a>

        <a
          href="/active-sessions"
          className="block ui-card ui-card-warm-hover p-6 transition-colors group"
        >
          <h2 className="text-xl font-bold mb-2 ui-text-primary group-hover:text-[var(--ui-accent)] transition-colors">
            Active Sessions
          </h2>
          <p className="ui-text-secondary text-sm">
            Browse fireteams currently running raids. See who is in each
            session and how long they have been going.
          </p>
        </a>
      </div>
    </div>
  );
}
