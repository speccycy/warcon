-- Each player's settled totals per server, for the all-time reads (the boards and their export,
-- career ranks, the placeholders' stats, the risk record): one row per (server, player) with the
-- sums of the player's closed sessions and of their lines of ended matches. Those reads take these
-- rows plus the open sessions instead of every session and line ever written.
--
-- Kept by triggers, in the same transaction as whatever writes the sources, whoever the writer is
-- (the worker, the purge, a test, a hand repair, an older build after a rollback):
--   - the two hot transitions add, in BEFORE row triggers: a session closing (left_at set) adds
--     the session to its pair; a match ending (ended_at set) adds each of its lines to its pair;
--   - every other change recounts the pairs it touched from the sources, in AFTER triggers: a
--     closed session inserted, changed or deleted; an ended match inserted, changed or deleted;
--     lines of an ended match inserted, changed or deleted. AFTER triggers see the whole
--     statement, so a recount after an add in the same statement counts the added row once.
-- player_totals_lock(server) orders everything that writes a server's totals. The worker and the
-- purge take it before they touch a row, so they never wait for it while holding a row the other
-- needs; the trigger functions take it again (re-entrant), which guards hand edits. A hand edit of
-- sessions, matches or lines starts with SELECT player_totals_lock('<server id>'). A bulk load (a
-- backfill) disables these triggers, loads, calls player_totals_rebuild() and enables them again,
-- all in one transaction with nothing else writing; session_replication_role = replica disables
-- them too and must not be used for anything else.
--
-- Order: the table and the functions first (no lock on a busy table); then the triggers, in the
-- order every writer takes those tables (sessions, then lines, then matches), each CREATE TRIGGER
-- holding its table against writes until the migrations commit; then the rebuild, into the table
-- before its key exists, and the key last. The rebuild sees every session closed and every match
-- ended before the locks, and nothing can close or end between it and the triggers taking over.
CREATE TABLE "player_totals" (
	"server_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"seconds" numeric DEFAULT '0' NOT NULL,
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
-- A player's result in a match: matchResult() in $lib/leaderboard, as lines() in leaderboards.ts
-- writes it out (no faction, or a faction not on a scoreboard that has one: none; then the
-- winner; then a draw if anybody scored a number; else none).
CREATE FUNCTION "match_result"(final_scores jsonb, winner text, faction text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT CASE WHEN faction IS NULL THEN NULL
	            WHEN jsonb_typeof(final_scores) = 'array' AND jsonb_array_length(final_scores) > 0
	                 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(final_scores) e WHERE e->>'name' = faction)
	                 THEN NULL
	            WHEN winner IS NOT NULL THEN CASE WHEN winner = faction THEN 'win' ELSE 'loss' END
	            WHEN jsonb_typeof(final_scores) = 'array'
	                 AND (SELECT MAX(CASE WHEN jsonb_typeof(e->'score') = 'number' THEN (e->>'score')::numeric END)
	                        FROM jsonb_array_elements(final_scores) e) > 0 THEN 'draw'
	            ELSE NULL END
$$;--> statement-breakpoint
-- Every writer of the totals reads its sources at READ COMMITTED: a recount from an older snapshot
-- (REPEATABLE READ, SERIALIZABLE) could put back what a purge committed meanwhile had removed.
CREATE FUNCTION "player_totals_lock"(server_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF current_setting('transaction_isolation') <> 'read committed' THEN
		RAISE EXCEPTION 'player_totals is written at READ COMMITTED only (this transaction is %)',
			current_setting('transaction_isolation');
	END IF;
	PERFORM pg_advisory_xact_lock(hashtextextended('totals:' || server_id, 0));
END $$;--> statement-breakpoint
-- These players' rows on this server, worked out again from their closed sessions and their lines
-- of ended matches (joined on match and server, as lines() joins them); a row with neither goes.
CREATE FUNCTION "player_totals_recount"(sid text, pids text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(sid);
	INSERT INTO player_totals AS t (server_id, steam_id, sessions, seconds, seed_seconds, cash, last_seen,
	                                matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                                kill_streak, death_streak, wins, losses, draws)
	SELECT sid, p.steam_id, s.sessions, s.seconds, s.seed_seconds, s.cash, s.last_seen,
	       l.matches, l.kills, l.deaths, l.headshots, l.team_kills, l.suicides, l.vehicle_kills,
	       l.kill_streak, l.death_streak, l.wins, l.losses, l.draws
	  FROM (SELECT DISTINCT unnest(pids) AS steam_id) p
	  CROSS JOIN LATERAL (
		SELECT COUNT(*)::int AS sessions,
		       COALESCE(SUM(EXTRACT(EPOCH FROM (ps.left_at - ps.joined_at))), 0) AS seconds,
		       COALESCE(SUM(ps.seed_seconds), 0) AS seed_seconds, COALESCE(SUM(ps.cash), 0) AS cash,
		       MAX(ps.last_seen) AS last_seen
		  FROM player_sessions ps
		 WHERE ps.steam_id = p.steam_id AND ps.server_id = sid AND ps.left_at IS NOT NULL) s
	  CROSS JOIN LATERAL (
		SELECT COUNT(*)::int AS matches, COALESCE(SUM(mp.kills), 0) AS kills, COALESCE(SUM(mp.deaths), 0) AS deaths,
		       COALESCE(SUM(mp.headshots), 0) AS headshots, COALESCE(SUM(mp.team_kills), 0) AS team_kills,
		       COALESCE(SUM(mp.suicides), 0) AS suicides, COALESCE(SUM(mp.vehicle_kills), 0) AS vehicle_kills,
		       COALESCE(MAX(mp.kill_streak), 0) AS kill_streak, COALESCE(MAX(mp.death_streak), 0) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws
		  FROM match_players mp
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		  CROSS JOIN LATERAL (SELECT match_result(m.final_scores, m.winner, mp.faction) AS r) x
		 WHERE mp.steam_id = p.steam_id AND mp.server_id = sid AND m.ended_at IS NOT NULL) l
	ON CONFLICT (server_id, steam_id) DO UPDATE SET
		sessions = EXCLUDED.sessions, seconds = EXCLUDED.seconds, seed_seconds = EXCLUDED.seed_seconds,
		cash = EXCLUDED.cash, last_seen = EXCLUDED.last_seen, matches = EXCLUDED.matches, kills = EXCLUDED.kills,
		deaths = EXCLUDED.deaths, headshots = EXCLUDED.headshots, team_kills = EXCLUDED.team_kills,
		suicides = EXCLUDED.suicides, vehicle_kills = EXCLUDED.vehicle_kills, kill_streak = EXCLUDED.kill_streak,
		death_streak = EXCLUDED.death_streak, wins = EXCLUDED.wins, losses = EXCLUDED.losses, draws = EXCLUDED.draws;
	DELETE FROM player_totals WHERE server_id = sid AND steam_id = ANY (pids) AND sessions = 0 AND matches = 0;
END $$;--> statement-breakpoint
-- A session closing (BEFORE, so a recount later in the same statement sees it once).
CREATE FUNCTION "player_totals_session_closed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(NEW.server_id);
	INSERT INTO player_totals AS t (server_id, steam_id, sessions, seconds, seed_seconds, cash, last_seen)
	VALUES (NEW.server_id, NEW.steam_id, 1, EXTRACT(EPOCH FROM (NEW.left_at - NEW.joined_at)), NEW.seed_seconds,
	        NEW.cash, NEW.last_seen)
	ON CONFLICT (server_id, steam_id) DO UPDATE SET
		sessions = t.sessions + 1, seconds = t.seconds + EXCLUDED.seconds,
		seed_seconds = t.seed_seconds + EXCLUDED.seed_seconds, cash = t.cash + EXCLUDED.cash,
		last_seen = GREATEST(t.last_seen, EXCLUDED.last_seen);
	RETURN NEW;
END $$;--> statement-breakpoint
-- A closed session inserted, changed or deleted: its pair (and the pair it moved to) recounted.
CREATE FUNCTION "player_totals_session_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP <> 'INSERT' THEN
		PERFORM player_totals_recount(OLD.server_id, ARRAY[OLD.steam_id]);
	END IF;
	IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.server_id, NEW.steam_id) IS DISTINCT FROM (OLD.server_id, OLD.steam_id)) THEN
		PERFORM player_totals_recount(NEW.server_id, ARRAY[NEW.steam_id]);
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
-- A match ending: each of its lines added with its result (BEFORE, as for a close). The worker
-- writes the lines and the feed's columns before it sets ended_at, in the same transaction.
CREATE FUNCTION "player_totals_match_ended"() RETURNS trigger LANGUAGE plpgsql AS $$
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
		kill_streak = GREATEST(t.kill_streak, EXCLUDED.kill_streak),
		death_streak = GREATEST(t.death_streak, EXCLUDED.death_streak),
		wins = t.wins + EXCLUDED.wins, losses = t.losses + EXCLUDED.losses, draws = t.draws + EXCLUDED.draws;
	RETURN NEW;
END $$;--> statement-breakpoint
-- An ended match inserted, changed or deleted: the pairs of its lines recounted, on its server
-- before and after.
CREATE FUNCTION "player_totals_match_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	pids text[];
BEGIN
	IF TG_OP <> 'INSERT' THEN
		SELECT array_agg(DISTINCT steam_id) INTO pids FROM match_players WHERE match_id = OLD.id AND server_id = OLD.server_id;
		IF pids IS NOT NULL THEN PERFORM player_totals_recount(OLD.server_id, pids); END IF;
	END IF;
	IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.id, NEW.server_id) IS DISTINCT FROM (OLD.id, OLD.server_id)) THEN
		SELECT array_agg(DISTINCT steam_id) INTO pids FROM match_players WHERE match_id = NEW.id AND server_id = NEW.server_id;
		IF pids IS NOT NULL THEN PERFORM player_totals_recount(NEW.server_id, pids); END IF;
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
-- Lines of ended matches inserted, changed or deleted (one function per event, as transition
-- tables require): every pair they touch recounted, a server at a time. The worker only writes
-- the lines of the match in progress, which these find nothing to do for.
CREATE FUNCTION "player_totals_lines_inserted"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	s record;
BEGIN
	FOR s IN
		SELECT n.server_id, array_agg(DISTINCT n.steam_id) AS pids
		  FROM lines_new n JOIN matches m ON m.id = n.match_id AND m.server_id = n.server_id
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY n.server_id ORDER BY n.server_id
	LOOP
		PERFORM player_totals_recount(s.server_id, s.pids);
	END LOOP;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE FUNCTION "player_totals_lines_updated"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	s record;
BEGIN
	FOR s IN
		SELECT k.server_id, array_agg(DISTINCT k.steam_id) AS pids
		  FROM (SELECT match_id, server_id, steam_id FROM lines_old
		        UNION ALL SELECT match_id, server_id, steam_id FROM lines_new) k
		  JOIN matches m ON m.id = k.match_id AND m.server_id = k.server_id
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY k.server_id ORDER BY k.server_id
	LOOP
		PERFORM player_totals_recount(s.server_id, s.pids);
	END LOOP;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE FUNCTION "player_totals_lines_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	s record;
BEGIN
	FOR s IN
		SELECT o.server_id, array_agg(DISTINCT o.steam_id) AS pids
		  FROM lines_old o JOIN matches m ON m.id = o.match_id AND m.server_id = o.server_id
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY o.server_id ORDER BY o.server_id
	LOOP
		PERFORM player_totals_recount(s.server_id, s.pids);
	END LOOP;
	RETURN NULL;
END $$;--> statement-breakpoint
-- Every row worked out again from the sources: what the migration fills the table with, and what a
-- bulk load ends with (see the top of this file). One insert of both aggregates joined; each match's
-- result worked out once per side that played it rather than once per line (Postgres runs the
-- SELECT of an INSERT without parallel workers, so the per-line function calls were most of it).
CREATE FUNCTION "player_totals_rebuild"() RETURNS void LANGUAGE plpgsql AS $$
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
END $$;--> statement-breakpoint
CREATE TRIGGER "player_totals_session_closed" BEFORE UPDATE OF "left_at" ON "player_sessions"
	FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL) EXECUTE FUNCTION player_totals_session_closed();--> statement-breakpoint
CREATE TRIGGER "player_totals_session_inserted" AFTER INSERT ON "player_sessions"
	FOR EACH ROW WHEN (NEW.left_at IS NOT NULL) EXECUTE FUNCTION player_totals_session_changed();--> statement-breakpoint
CREATE TRIGGER "player_totals_session_updated" AFTER UPDATE ON "player_sessions"
	FOR EACH ROW WHEN (OLD.left_at IS NOT NULL) EXECUTE FUNCTION player_totals_session_changed();--> statement-breakpoint
CREATE TRIGGER "player_totals_session_deleted" AFTER DELETE ON "player_sessions"
	FOR EACH ROW WHEN (OLD.left_at IS NOT NULL) EXECUTE FUNCTION player_totals_session_changed();--> statement-breakpoint
CREATE TRIGGER "player_totals_lines_inserted" AFTER INSERT ON "match_players"
	REFERENCING NEW TABLE AS lines_new FOR EACH STATEMENT EXECUTE FUNCTION player_totals_lines_inserted();--> statement-breakpoint
CREATE TRIGGER "player_totals_lines_updated" AFTER UPDATE ON "match_players"
	REFERENCING OLD TABLE AS lines_old NEW TABLE AS lines_new FOR EACH STATEMENT EXECUTE FUNCTION player_totals_lines_updated();--> statement-breakpoint
CREATE TRIGGER "player_totals_lines_deleted" AFTER DELETE ON "match_players"
	REFERENCING OLD TABLE AS lines_old FOR EACH STATEMENT EXECUTE FUNCTION player_totals_lines_deleted();--> statement-breakpoint
CREATE TRIGGER "player_totals_match_ended" BEFORE UPDATE OF "ended_at" ON "matches"
	FOR EACH ROW WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL) EXECUTE FUNCTION player_totals_match_ended();--> statement-breakpoint
CREATE TRIGGER "player_totals_match_inserted" AFTER INSERT ON "matches"
	FOR EACH ROW WHEN (NEW.ended_at IS NOT NULL) EXECUTE FUNCTION player_totals_match_changed();--> statement-breakpoint
CREATE TRIGGER "player_totals_match_updated" AFTER UPDATE ON "matches"
	FOR EACH ROW WHEN (OLD.ended_at IS NOT NULL) EXECUTE FUNCTION player_totals_match_changed();--> statement-breakpoint
CREATE TRIGGER "player_totals_match_deleted" AFTER DELETE ON "matches"
	FOR EACH ROW WHEN (OLD.ended_at IS NOT NULL) EXECUTE FUNCTION player_totals_match_changed();--> statement-breakpoint
SELECT player_totals_rebuild();--> statement-breakpoint
ALTER TABLE "player_totals" ADD CONSTRAINT "player_totals_server_id_steam_id_pk" PRIMARY KEY("server_id","steam_id");
