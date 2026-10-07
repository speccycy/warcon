-- Each player's settled totals per server per UTC day (player_days), for the ranged boards (7, 30
-- and 90 days). rangeBase in leaderboards.ts reads a range from F as: the rows of every day after
-- F's (D1 = F's UTC day + 1); for each session that crossed D1's midnight (its joined_at is kept on
-- D1's row), its time from F, or its join, to that midnight; and, read raw, the sessions closed in
-- [F, D1's midnight), the lines of matches ended in it and the open sessions. Exact to the
-- microsecond for every F, as the all-time reads are with player_totals.
--
-- Kept by 0038's triggers, whose functions are replaced here: no new trigger, the same lock, the
-- same READ COMMITTED rule. A session closing adds its seconds within each UTC day it spans, its
-- joined_at to each day whose midnight it crossed, and its count, seed time, cash and last sighting
-- to the day it left; a match ending adds each line to the day it ended; every other change
-- recounts the (player, day) keys it touched, before and after. A UTC day is
-- (ts AT TIME ZONE 'UTC')::date, never the connection's time zone.
--
-- The rule the rows rest on: a closed session has last_seen = left_at. The worker closes sessions
-- so; a range counts a closed session by both, the rows place it by left_at. The session triggers
-- refuse a closed session that breaks the rule, and the rebuild refuses to start over one.
--
-- Also here: a streak merged into a row with no match yet takes the line's own value (GREATEST
-- with the row's 0 lost a negative one), in player_totals too, whose pairs with such a line are
-- recounted once; and when a statement leaves a server with no lines at all (the purge), the line
-- columns of its rows are cleared in one pass instead of recounted key by key, which held the
-- server's lock for as long as its history (39 s for a busy server's 95 days, measured).
--
-- Order: the table and the functions first (no busy table locked; other sessions keep running the
-- old trigger bodies until the commit). Then the three sources locked against writes in the
-- writers' order (sessions, lines, matches), so nothing closes or ends between the rebuild and the
-- new bodies: a writer queued behind the lock resumes after the commit with the new bodies and a
-- snapshot that sees the rows. Then the index on matches, after the lock: taken before it, it would
-- hold matches while the lock waits for a match end that has already written its lines. Then the
-- rebuild, into the table before its key exists, and the key last. Deploy it in its own quiet-hour
-- window, not in one migration run with 0038 (one transaction: both rebuilds under the locks).
CREATE TABLE "player_days" (
	"server_id" text NOT NULL,
	"day" date NOT NULL,
	"steam_id" text NOT NULL,
	"seconds" numeric DEFAULT '0' NOT NULL,
	"crossings" timestamp with time zone[],
	"sessions" integer DEFAULT 0 NOT NULL,
	"seed_seconds" bigint DEFAULT 0 NOT NULL,
	"cash" bigint DEFAULT 0 NOT NULL,
	"last_seen" timestamp with time zone,
	"matches" integer DEFAULT 0 NOT NULL,
	"kills" bigint DEFAULT 0 NOT NULL,
	"deaths" bigint DEFAULT 0 NOT NULL,
	"headshots" bigint DEFAULT 0 NOT NULL,
	"team_kills" bigint DEFAULT 0 NOT NULL,
	"suicides" bigint DEFAULT 0 NOT NULL,
	"vehicle_kills" bigint DEFAULT 0 NOT NULL,
	"kill_streak" integer DEFAULT 0 NOT NULL,
	"death_streak" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL
) WITH (fillfactor = 90);--> statement-breakpoint
-- A closed session's parts, one per UTC day from the day it joined to the day it left: its seconds
-- within the day, and whether it crossed the day's midnight (true on every day after the first).
-- They sum to left - joined exactly. A session that left before it joined (never the worker's; a
-- hand edit) is one part on the day it left, with no crossing.
CREATE FUNCTION "session_day_parts"(joined timestamptz, "left" timestamptz)
RETURNS TABLE (day date, seconds numeric, crossing boolean)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT d,
	       CASE WHEN joined < "left"
	            THEN EXTRACT(EPOCH FROM (LEAST("left", (d + 1)::timestamp AT TIME ZONE 'UTC')
	                                     - GREATEST(joined, d::timestamp AT TIME ZONE 'UTC')))
	            ELSE EXTRACT(EPOCH FROM ("left" - joined)) END,
	       joined < d::timestamp AT TIME ZONE 'UTC'
	  FROM (SELECT (joined AT TIME ZONE 'UTC')::date AS jd, ("left" AT TIME ZONE 'UTC')::date AS ld) b,
	       generate_series(0, b.ld - LEAST(b.jd, b.ld)) i,
	       LATERAL (SELECT LEAST(b.jd, b.ld) + i AS d) x
$$;--> statement-breakpoint
-- Two crossing lists as one, in order, duplicates kept; null when both are.
CREATE FUNCTION "player_days_crossings"(a timestamptz[], b timestamptz[]) RETURNS timestamptz[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT array_agg(c ORDER BY c) FROM (SELECT unnest(a) UNION ALL SELECT unnest(b)) u(c)
$$;--> statement-breakpoint
CREATE FUNCTION "player_sessions_closed_rule"(left_at timestamptz, last_seen timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	IF left_at IS NOT NULL AND last_seen IS DISTINCT FROM left_at THEN
		RAISE EXCEPTION 'a closed player session must have last_seen equal to left_at (migration 0039)';
	END IF;
END $$;--> statement-breakpoint
-- These (player, day) keys of this server worked out again from the sources: the pair's closed
-- sessions that touch the day (each split once) and its lines of matches that ended on it. A key
-- left with nothing goes. The keys come as two arrays of the same length, player and day.
CREATE FUNCTION "player_days_recount"(sid text, pids text[], days date[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(sid);
	INSERT INTO player_days AS t (server_id, day, steam_id, seconds, crossings, sessions, seed_seconds, cash, last_seen,
	                              matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                              kill_streak, death_streak, wins, losses, draws)
	WITH k AS (SELECT DISTINCT u.p, u.d FROM unnest(pids, days) AS u(p, d) WHERE u.d IS NOT NULL),
	c AS (
		SELECT DISTINCT ps.id, ps.steam_id, ps.joined_at, ps.left_at, ps.seed_seconds, ps.cash, ps.last_seen
		  FROM k JOIN player_sessions ps ON ps.steam_id = k.p AND ps.server_id = sid AND ps.left_at IS NOT NULL
		   AND ps.left_at >= k.d::timestamp AT TIME ZONE 'UTC'
		   AND LEAST(ps.joined_at, ps.left_at) < (k.d + 1)::timestamp AT TIME ZONE 'UTC'),
	s AS (
		SELECT c.steam_id AS p, x.day AS d, SUM(x.seconds) AS seconds,
		       array_agg(c.joined_at ORDER BY c.joined_at) FILTER (WHERE x.crossing) AS crossings,
		       (COUNT(*) FILTER (WHERE x.closes))::int AS sessions,
		       COALESCE(SUM(c.seed_seconds) FILTER (WHERE x.closes), 0) AS seed_seconds,
		       COALESCE(SUM(c.cash) FILTER (WHERE x.closes), 0) AS cash,
		       MAX(c.last_seen) FILTER (WHERE x.closes) AS last_seen
		  FROM c CROSS JOIN LATERAL (
		         SELECT p.day, p.seconds, p.crossing, p.day = (c.left_at AT TIME ZONE 'UTC')::date AS closes
		           FROM session_day_parts(c.joined_at, c.left_at) p) x
		  JOIN k ON k.p = c.steam_id AND k.d = x.day
		 GROUP BY 1, 2),
	l AS (
		SELECT k.p, k.d, COUNT(*)::int AS matches, SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths,
		       SUM(mp.headshots) AS headshots, SUM(mp.team_kills) AS team_kills, SUM(mp.suicides) AS suicides,
		       SUM(mp.vehicle_kills) AS vehicle_kills, MAX(mp.kill_streak) AS kill_streak,
		       MAX(mp.death_streak) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws
		  FROM k JOIN match_players mp ON mp.steam_id = k.p AND mp.server_id = sid
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		   AND m.ended_at >= k.d::timestamp AT TIME ZONE 'UTC' AND m.ended_at < (k.d + 1)::timestamp AT TIME ZONE 'UTC'
		  CROSS JOIN LATERAL (SELECT match_result(m.final_scores, m.winner, mp.faction) AS r) x
		 GROUP BY k.p, k.d)
	SELECT sid, k.d, k.p, COALESCE(s.seconds, 0), s.crossings, COALESCE(s.sessions, 0), COALESCE(s.seed_seconds, 0),
	       COALESCE(s.cash, 0), s.last_seen, COALESCE(l.matches, 0), COALESCE(l.kills, 0), COALESCE(l.deaths, 0),
	       COALESCE(l.headshots, 0), COALESCE(l.team_kills, 0), COALESCE(l.suicides, 0), COALESCE(l.vehicle_kills, 0),
	       COALESCE(l.kill_streak, 0), COALESCE(l.death_streak, 0), COALESCE(l.wins, 0), COALESCE(l.losses, 0),
	       COALESCE(l.draws, 0)
	  FROM k LEFT JOIN s ON s.p = k.p AND s.d = k.d LEFT JOIN l ON l.p = k.p AND l.d = k.d
	ON CONFLICT (server_id, day, steam_id) DO UPDATE SET
		seconds = EXCLUDED.seconds, crossings = EXCLUDED.crossings, sessions = EXCLUDED.sessions,
		seed_seconds = EXCLUDED.seed_seconds, cash = EXCLUDED.cash, last_seen = EXCLUDED.last_seen,
		matches = EXCLUDED.matches, kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, headshots = EXCLUDED.headshots,
		team_kills = EXCLUDED.team_kills, suicides = EXCLUDED.suicides, vehicle_kills = EXCLUDED.vehicle_kills,
		kill_streak = EXCLUDED.kill_streak, death_streak = EXCLUDED.death_streak, wins = EXCLUDED.wins,
		losses = EXCLUDED.losses, draws = EXCLUDED.draws;
	DELETE FROM player_days t USING (SELECT DISTINCT u.p, u.d FROM unnest(pids, days) AS u(p, d)) k
	 WHERE t.server_id = sid AND t.steam_id = k.p AND t.day = k.d
	   AND t.sessions = 0 AND t.matches = 0 AND t.seconds = 0 AND t.crossings IS NULL;
END $$;--> statement-breakpoint
-- The day keys a closed session touches, recounted.
CREATE FUNCTION "player_days_recount_session"(sid text, pid text, joined timestamptz, "left" timestamptz)
RETURNS void LANGUAGE sql AS $$
	SELECT player_days_recount(sid, array_agg(pid), array_agg(day)) FROM session_day_parts(joined, "left")
$$;--> statement-breakpoint
-- The server has no lines left (a purge): every row's line columns are zero, cleared in one pass,
-- and rows left with nothing go.
CREATE FUNCTION "player_lines_cleared"(sid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(sid);
	UPDATE player_totals SET matches = 0, kills = 0, deaths = 0, headshots = 0, team_kills = 0, suicides = 0,
	       vehicle_kills = 0, kill_streak = 0, death_streak = 0, wins = 0, losses = 0, draws = 0
	 WHERE server_id = sid AND matches > 0;
	DELETE FROM player_totals WHERE server_id = sid AND sessions = 0 AND matches = 0;
	UPDATE player_days SET matches = 0, kills = 0, deaths = 0, headshots = 0, team_kills = 0, suicides = 0,
	       vehicle_kills = 0, kill_streak = 0, death_streak = 0, wins = 0, losses = 0, draws = 0
	 WHERE server_id = sid AND matches > 0;
	DELETE FROM player_days
	 WHERE server_id = sid AND sessions = 0 AND matches = 0 AND seconds = 0 AND crossings IS NULL;
END $$;--> statement-breakpoint
-- A session closing (BEFORE, so a recount later in the same statement sees it once): its pair's
-- totals, then its part of each day, its crossings and, on the day it left, its count and sums.
CREATE OR REPLACE FUNCTION "player_totals_session_closed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_sessions_closed_rule(NEW.left_at, NEW.last_seen);
	PERFORM player_totals_lock(NEW.server_id);
	INSERT INTO player_totals AS t (server_id, steam_id, sessions, seconds, seed_seconds, cash, last_seen)
	VALUES (NEW.server_id, NEW.steam_id, 1, EXTRACT(EPOCH FROM (NEW.left_at - NEW.joined_at)), NEW.seed_seconds,
	        NEW.cash, NEW.last_seen)
	ON CONFLICT (server_id, steam_id) DO UPDATE SET
		sessions = t.sessions + 1, seconds = t.seconds + EXCLUDED.seconds,
		seed_seconds = t.seed_seconds + EXCLUDED.seed_seconds, cash = t.cash + EXCLUDED.cash,
		last_seen = GREATEST(t.last_seen, EXCLUDED.last_seen);
	INSERT INTO player_days AS t (server_id, day, steam_id, seconds, crossings, sessions, seed_seconds, cash, last_seen)
	SELECT NEW.server_id, x.day, NEW.steam_id, x.seconds, CASE WHEN x.crossing THEN ARRAY[NEW.joined_at] END,
	       x.closes::int, CASE WHEN x.closes THEN NEW.seed_seconds ELSE 0 END,
	       CASE WHEN x.closes THEN NEW.cash ELSE 0 END, CASE WHEN x.closes THEN NEW.last_seen END
	  FROM (SELECT p.day, p.seconds, p.crossing, p.day = (NEW.left_at AT TIME ZONE 'UTC')::date AS closes
	          FROM session_day_parts(NEW.joined_at, NEW.left_at) p) x
	ON CONFLICT (server_id, day, steam_id) DO UPDATE SET
		seconds = t.seconds + EXCLUDED.seconds, crossings = player_days_crossings(t.crossings, EXCLUDED.crossings),
		sessions = t.sessions + EXCLUDED.sessions, seed_seconds = t.seed_seconds + EXCLUDED.seed_seconds,
		cash = t.cash + EXCLUDED.cash, last_seen = GREATEST(t.last_seen, EXCLUDED.last_seen);
	RETURN NEW;
END $$;--> statement-breakpoint
-- A closed session inserted, changed or deleted: its pair (and the pair it moved to) recounted, and
-- the days it touched before and after, even when its pair stayed the same.
CREATE OR REPLACE FUNCTION "player_totals_session_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP <> 'DELETE' THEN
		PERFORM player_sessions_closed_rule(NEW.left_at, NEW.last_seen);
	END IF;
	IF TG_OP <> 'INSERT' THEN
		PERFORM player_totals_recount(OLD.server_id, ARRAY[OLD.steam_id]);
		PERFORM player_days_recount_session(OLD.server_id, OLD.steam_id, OLD.joined_at, OLD.left_at);
	END IF;
	IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.server_id, NEW.steam_id) IS DISTINCT FROM (OLD.server_id, OLD.steam_id)) THEN
		PERFORM player_totals_recount(NEW.server_id, ARRAY[NEW.steam_id]);
	END IF;
	IF TG_OP <> 'DELETE' AND NEW.left_at IS NOT NULL THEN
		PERFORM player_days_recount_session(NEW.server_id, NEW.steam_id, NEW.joined_at, NEW.left_at);
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
-- A match ending: each of its lines added with its result to its pair and to the day the match
-- ended (BEFORE, as for a close). The worker writes the lines and the feed's columns before it sets
-- ended_at, in the same transaction. A streak goes into a row with no match yet as it is.
CREATE OR REPLACE FUNCTION "player_totals_match_ended"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(NEW.server_id);
	INSERT INTO player_totals AS t (server_id, steam_id, matches, kills, deaths, headshots, team_kills, suicides,
	                                vehicle_kills, kill_streak, death_streak, wins, losses, draws)
	SELECT mp.server_id, mp.steam_id, 1, mp.kills, mp.deaths, mp.headshots, mp.team_kills, mp.suicides,
	       mp.vehicle_kills, mp.kill_streak, mp.death_streak,
	       CASE WHEN x.r = 'win' THEN 1 ELSE 0 END, CASE WHEN x.r = 'loss' THEN 1 ELSE 0 END,
	       CASE WHEN x.r = 'draw' THEN 1 ELSE 0 END
	  FROM match_players mp
	  CROSS JOIN LATERAL (SELECT match_result(NEW.final_scores, NEW.winner, mp.faction) AS r) x
	 WHERE mp.match_id = NEW.id AND mp.server_id = NEW.server_id
	ON CONFLICT (server_id, steam_id) DO UPDATE SET
		matches = t.matches + EXCLUDED.matches, kills = t.kills + EXCLUDED.kills, deaths = t.deaths + EXCLUDED.deaths,
		headshots = t.headshots + EXCLUDED.headshots, team_kills = t.team_kills + EXCLUDED.team_kills,
		suicides = t.suicides + EXCLUDED.suicides, vehicle_kills = t.vehicle_kills + EXCLUDED.vehicle_kills,
		kill_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.kill_streak ELSE GREATEST(t.kill_streak, EXCLUDED.kill_streak) END,
		death_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.death_streak ELSE GREATEST(t.death_streak, EXCLUDED.death_streak) END,
		wins = t.wins + EXCLUDED.wins, losses = t.losses + EXCLUDED.losses, draws = t.draws + EXCLUDED.draws;
	INSERT INTO player_days AS t (server_id, day, steam_id, matches, kills, deaths, headshots, team_kills, suicides,
	                              vehicle_kills, kill_streak, death_streak, wins, losses, draws)
	SELECT mp.server_id, (NEW.ended_at AT TIME ZONE 'UTC')::date, mp.steam_id, 1, mp.kills, mp.deaths, mp.headshots,
	       mp.team_kills, mp.suicides, mp.vehicle_kills, mp.kill_streak, mp.death_streak,
	       CASE WHEN x.r = 'win' THEN 1 ELSE 0 END, CASE WHEN x.r = 'loss' THEN 1 ELSE 0 END,
	       CASE WHEN x.r = 'draw' THEN 1 ELSE 0 END
	  FROM match_players mp
	  CROSS JOIN LATERAL (SELECT match_result(NEW.final_scores, NEW.winner, mp.faction) AS r) x
	 WHERE mp.match_id = NEW.id AND mp.server_id = NEW.server_id
	ON CONFLICT (server_id, day, steam_id) DO UPDATE SET
		matches = t.matches + EXCLUDED.matches, kills = t.kills + EXCLUDED.kills, deaths = t.deaths + EXCLUDED.deaths,
		headshots = t.headshots + EXCLUDED.headshots, team_kills = t.team_kills + EXCLUDED.team_kills,
		suicides = t.suicides + EXCLUDED.suicides, vehicle_kills = t.vehicle_kills + EXCLUDED.vehicle_kills,
		kill_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.kill_streak ELSE GREATEST(t.kill_streak, EXCLUDED.kill_streak) END,
		death_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.death_streak ELSE GREATEST(t.death_streak, EXCLUDED.death_streak) END,
		wins = t.wins + EXCLUDED.wins, losses = t.losses + EXCLUDED.losses, draws = t.draws + EXCLUDED.draws;
	RETURN NEW;
END $$;--> statement-breakpoint
-- An ended match inserted, changed or deleted: the pairs of its lines recounted, on its server
-- before and after, and the days it ended on before and after (a moved end changes the day alone).
CREATE OR REPLACE FUNCTION "player_totals_match_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	pids text[];
BEGIN
	IF TG_OP <> 'INSERT' THEN
		SELECT array_agg(DISTINCT steam_id) INTO pids FROM match_players WHERE match_id = OLD.id AND server_id = OLD.server_id;
		IF pids IS NOT NULL THEN
			PERFORM player_totals_recount(OLD.server_id, pids);
			PERFORM player_days_recount(OLD.server_id, pids,
				array_fill((OLD.ended_at AT TIME ZONE 'UTC')::date, ARRAY[cardinality(pids)]));
		END IF;
	END IF;
	IF TG_OP <> 'DELETE' AND NEW.ended_at IS NOT NULL THEN
		SELECT array_agg(DISTINCT steam_id) INTO pids FROM match_players WHERE match_id = NEW.id AND server_id = NEW.server_id;
		IF pids IS NOT NULL THEN
			IF TG_OP = 'INSERT' OR (NEW.id, NEW.server_id) IS DISTINCT FROM (OLD.id, OLD.server_id) THEN
				PERFORM player_totals_recount(NEW.server_id, pids);
			END IF;
			PERFORM player_days_recount(NEW.server_id, pids,
				array_fill((NEW.ended_at AT TIME ZONE 'UTC')::date, ARRAY[cardinality(pids)]));
		END IF;
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
-- Lines of ended matches inserted, changed or deleted (one function per event, as transition
-- tables require): every pair they touch recounted, and every (player, day the match ended) key, a
-- server at a time. The worker only writes the lines of the match in progress, which these find
-- nothing to do for.
CREATE OR REPLACE FUNCTION "player_totals_lines_inserted"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	s record;
BEGIN
	FOR s IN
		SELECT n.server_id, array_agg(n.steam_id) AS pids, array_agg((m.ended_at AT TIME ZONE 'UTC')::date) AS days
		  FROM lines_new n JOIN matches m ON m.id = n.match_id AND m.server_id = n.server_id
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY n.server_id ORDER BY n.server_id
	LOOP
		PERFORM player_totals_recount(s.server_id, s.pids);
		PERFORM player_days_recount(s.server_id, s.pids, s.days);
	END LOOP;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_totals_lines_updated"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	s record;
BEGIN
	FOR s IN
		SELECT k.server_id, array_agg(k.steam_id) AS pids, array_agg((m.ended_at AT TIME ZONE 'UTC')::date) AS days
		  FROM (SELECT match_id, server_id, steam_id FROM lines_old
		        UNION ALL SELECT match_id, server_id, steam_id FROM lines_new) k
		  JOIN matches m ON m.id = k.match_id AND m.server_id = k.server_id
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY k.server_id ORDER BY k.server_id
	LOOP
		PERFORM player_totals_recount(s.server_id, s.pids);
		PERFORM player_days_recount(s.server_id, s.pids, s.days);
	END LOOP;
	RETURN NULL;
END $$;--> statement-breakpoint
-- A server left with no line at all (the purge) is cleared in one pass, before any key is gathered.
CREATE OR REPLACE FUNCTION "player_totals_lines_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	sid text;
	s record;
BEGIN
	FOR sid IN SELECT DISTINCT server_id FROM lines_old ORDER BY 1 LOOP
		IF NOT EXISTS (SELECT 1 FROM match_players WHERE server_id = sid) THEN
			PERFORM player_lines_cleared(sid);
		ELSE
			FOR s IN
				SELECT array_agg(o.steam_id) AS pids, array_agg((m.ended_at AT TIME ZONE 'UTC')::date) AS days
				  FROM lines_old o JOIN matches m ON m.id = o.match_id AND m.server_id = o.server_id
				 WHERE o.server_id = sid AND m.ended_at IS NOT NULL
				HAVING COUNT(*) > 0
			LOOP
				PERFORM player_totals_recount(sid, s.pids);
				PERFORM player_days_recount(sid, s.pids, s.days);
			END LOOP;
		END IF;
	END LOOP;
	RETURN NULL;
END $$;--> statement-breakpoint
-- Every day row worked out again from the sources: what the migration fills the table with, and
-- (through player_totals_rebuild) what a bulk load ends with. One insert of the sessions' parts
-- and the lines by day joined; each match's result worked out once per side that played it.
CREATE FUNCTION "player_days_rebuild"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM player_sessions WHERE left_at IS NOT NULL AND last_seen IS DISTINCT FROM left_at) THEN
		RAISE EXCEPTION 'a closed player session must have last_seen equal to left_at (migration 0039): player_days not built';
	END IF;
	DELETE FROM player_days;
	INSERT INTO player_days (server_id, day, steam_id, seconds, crossings, sessions, seed_seconds, cash, last_seen,
	                         matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                         kill_streak, death_streak, wins, losses, draws)
	WITH results AS (
		SELECT f.match_id, f.faction, match_result(m.final_scores, m.winner, f.faction) AS r
		  FROM (SELECT DISTINCT match_id, faction FROM match_players WHERE faction IS NOT NULL) f
		  JOIN matches m ON m.id = f.match_id
		 WHERE m.ended_at IS NOT NULL),
	s AS (
		SELECT ps.server_id, x.day, ps.steam_id, SUM(x.seconds) AS seconds,
		       array_agg(ps.joined_at ORDER BY ps.joined_at) FILTER (WHERE x.crossing) AS crossings,
		       (COUNT(*) FILTER (WHERE x.closes))::int AS sessions,
		       COALESCE(SUM(ps.seed_seconds) FILTER (WHERE x.closes), 0) AS seed_seconds,
		       COALESCE(SUM(ps.cash) FILTER (WHERE x.closes), 0) AS cash,
		       MAX(ps.last_seen) FILTER (WHERE x.closes) AS last_seen
		  FROM player_sessions ps CROSS JOIN LATERAL (
		         SELECT p.day, p.seconds, p.crossing, p.day = (ps.left_at AT TIME ZONE 'UTC')::date AS closes
		           FROM session_day_parts(ps.joined_at, ps.left_at) p) x
		 WHERE ps.left_at IS NOT NULL
		 GROUP BY 1, 2, 3),
	l AS (
		SELECT mp.server_id, (m.ended_at AT TIME ZONE 'UTC')::date AS day, mp.steam_id, COUNT(*)::int AS matches,
		       SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths, SUM(mp.headshots) AS headshots,
		       SUM(mp.team_kills) AS team_kills, SUM(mp.suicides) AS suicides, SUM(mp.vehicle_kills) AS vehicle_kills,
		       MAX(mp.kill_streak) AS kill_streak, MAX(mp.death_streak) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws
		  FROM match_players mp
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		  LEFT JOIN results x ON x.match_id = mp.match_id AND x.faction = mp.faction
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY 1, 2, 3)
	SELECT COALESCE(s.server_id, l.server_id), COALESCE(s.day, l.day), COALESCE(s.steam_id, l.steam_id),
	       COALESCE(s.seconds, 0), s.crossings, COALESCE(s.sessions, 0), COALESCE(s.seed_seconds, 0),
	       COALESCE(s.cash, 0), s.last_seen, COALESCE(l.matches, 0), COALESCE(l.kills, 0), COALESCE(l.deaths, 0),
	       COALESCE(l.headshots, 0), COALESCE(l.team_kills, 0), COALESCE(l.suicides, 0), COALESCE(l.vehicle_kills, 0),
	       COALESCE(l.kill_streak, 0), COALESCE(l.death_streak, 0), COALESCE(l.wins, 0), COALESCE(l.losses, 0),
	       COALESCE(l.draws, 0)
	  FROM s FULL JOIN l ON l.server_id = s.server_id AND l.day = s.day AND l.steam_id = s.steam_id;
END $$;--> statement-breakpoint
-- What a bulk load ends with (see 0038's header): the totals, then the day rows.
CREATE OR REPLACE FUNCTION "player_totals_rebuild"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM player_totals;
	INSERT INTO player_totals (server_id, steam_id, sessions, seconds, seed_seconds, cash, last_seen,
	                           matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                           kill_streak, death_streak, wins, losses, draws)
	WITH results AS (
		SELECT f.match_id, f.faction, match_result(m.final_scores, m.winner, f.faction) AS r
		  FROM (SELECT DISTINCT match_id, faction FROM match_players WHERE faction IS NOT NULL) f
		  JOIN matches m ON m.id = f.match_id
		 WHERE m.ended_at IS NOT NULL),
	s AS (
		SELECT server_id, steam_id, COUNT(*)::int AS sessions,
		       SUM(EXTRACT(EPOCH FROM (left_at - joined_at))) AS seconds,
		       SUM(seed_seconds) AS seed_seconds, SUM(cash) AS cash, MAX(last_seen) AS last_seen
		  FROM player_sessions WHERE left_at IS NOT NULL
		 GROUP BY server_id, steam_id),
	l AS (
		SELECT mp.server_id, mp.steam_id, COUNT(*)::int AS matches, SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths,
		       SUM(mp.headshots) AS headshots, SUM(mp.team_kills) AS team_kills, SUM(mp.suicides) AS suicides,
		       SUM(mp.vehicle_kills) AS vehicle_kills, MAX(mp.kill_streak) AS kill_streak,
		       MAX(mp.death_streak) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws
		  FROM match_players mp
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		  LEFT JOIN results x ON x.match_id = mp.match_id AND x.faction = mp.faction
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY mp.server_id, mp.steam_id)
	SELECT COALESCE(s.server_id, l.server_id), COALESCE(s.steam_id, l.steam_id),
	       COALESCE(s.sessions, 0), COALESCE(s.seconds, 0), COALESCE(s.seed_seconds, 0), COALESCE(s.cash, 0), s.last_seen,
	       COALESCE(l.matches, 0), COALESCE(l.kills, 0), COALESCE(l.deaths, 0), COALESCE(l.headshots, 0),
	       COALESCE(l.team_kills, 0), COALESCE(l.suicides, 0), COALESCE(l.vehicle_kills, 0),
	       COALESCE(l.kill_streak, 0), COALESCE(l.death_streak, 0),
	       COALESCE(l.wins, 0), COALESCE(l.losses, 0), COALESCE(l.draws, 0)
	  FROM s FULL JOIN l ON l.server_id = s.server_id AND l.steam_id = s.steam_id;
	PERFORM player_days_rebuild();
END $$;--> statement-breakpoint
-- A closed session that breaks the rule stops the migration here, before any lock (the rebuild
-- checks again under the locks, which nothing can change meanwhile).
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM player_sessions WHERE left_at IS NOT NULL AND last_seen IS DISTINCT FROM left_at) THEN
		RAISE EXCEPTION 'a closed player session must have last_seen equal to left_at (migration 0039): player_days not built';
	END IF;
END $$;--> statement-breakpoint
LOCK TABLE "player_sessions", "match_players", "matches" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
CREATE INDEX "matches_server_ended_idx" ON "matches" USING btree ("server_id","ended_at");--> statement-breakpoint
SELECT player_days_rebuild();--> statement-breakpoint
-- 0038 merged a line's streak into a pair with no match yet as GREATEST(0, streak), which kept 0 for
-- a negative one (never the worker's; a hand edit): every pair with such a line is recounted.
SELECT player_totals_recount(server_id, array_agg(DISTINCT steam_id))
  FROM match_players WHERE kill_streak < 0 OR death_streak < 0 GROUP BY server_id;--> statement-breakpoint
ALTER TABLE "player_days" ADD CONSTRAINT "player_days_server_id_day_steam_id_pk" PRIMARY KEY("server_id","day","steam_id");
