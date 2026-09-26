CREATE TABLE history_runs (
  id uuid PRIMARY KEY,
  slot timestamptz NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  targeted integer NOT NULL DEFAULT 0,
  observed integer NOT NULL DEFAULT 0
);

CREATE TABLE history_games (
  universe_id bigint PRIMARY KEY CHECK (universe_id > 0),
  root_place_id bigint NOT NULL CHECK (root_place_id > 0),
  name text NOT NULL,
  icon_url text,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL
);

CREATE TABLE history_chart_fetches (
  run_id uuid NOT NULL REFERENCES history_runs(id),
  chart_id text NOT NULL,
  observed_at timestamptz,
  status text NOT NULL CHECK (status IN ('complete','partial','failed')),
  rejected integer NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, chart_id)
);

CREATE TABLE history_chart_entries (
  run_id uuid NOT NULL,
  chart_id text NOT NULL,
  universe_id bigint NOT NULL REFERENCES history_games(universe_id),
  rank integer NOT NULL CHECK (rank > 0),
  name text NOT NULL,
  genre text,
  playing bigint NOT NULL CHECK (playing >= 0),
  sponsored boolean NOT NULL,
  PRIMARY KEY (run_id, chart_id, universe_id),
  FOREIGN KEY (run_id, chart_id) REFERENCES history_chart_fetches(run_id, chart_id)
);

CREATE TABLE history_targets (
  run_id uuid NOT NULL REFERENCES history_runs(id),
  universe_id bigint NOT NULL REFERENCES history_games(universe_id),
  status text NOT NULL CHECK (status IN ('pending','observed','unavailable')),
  PRIMARY KEY (run_id, universe_id)
);

CREATE TABLE history_observations (
  run_id uuid NOT NULL,
  universe_id bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  playing bigint NOT NULL CHECK (playing >= 0),
  visits bigint CHECK (visits >= 0),
  favorites bigint CHECK (favorites >= 0),
  likes bigint CHECK (likes >= 0),
  dislikes bigint CHECK (dislikes >= 0),
  PRIMARY KEY (run_id, universe_id),
  FOREIGN KEY (run_id, universe_id) REFERENCES history_targets(run_id, universe_id)
);
CREATE INDEX history_observations_game_time ON history_observations (universe_id, observed_at DESC);
CREATE INDEX history_chart_entries_game ON history_chart_entries (universe_id, run_id);
