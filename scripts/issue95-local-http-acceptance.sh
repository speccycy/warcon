#!/usr/bin/env bash
set -euo pipefail
umask 077
PG=/usr/lib/postgresql/18/bin
WARCON=/opt/infh-web-dev/warcon
URL=postgres://infh-dev@127.0.0.1:55495/warcon_issue95_test
if /usr/bin/ss -ltn | grep -Eq ':(55495|55496)[[:space:]]'; then echo 'BLOCKED: fixture port occupied'; exit 1; fi
TMP=$(mktemp -d /tmp/infh-issue95-http-XXXXXX)
WEB_PID=''
stop(){ local code=$?; trap - EXIT; if [ -n "$WEB_PID" ]; then kill "$WEB_PID" 2>/dev/null || true; wait "$WEB_PID" 2>/dev/null || true; fi; if test -f "$TMP/pg/PG_VERSION"; then "$PG/pg_ctl" -D "$TMP/pg" -m immediate -w stop > /dev/null 2>&1 || true; fi; rm -rf "$TMP"; echo "FIXTURE_CLEANUP_EXIT=$code"; exit "$code"; }
trap stop EXIT
"$PG/initdb" --no-instructions --auth=trust -D "$TMP/pg" -U infh-dev > "$TMP/init.log" 2>&1
"$PG/pg_ctl" -D "$TMP/pg" -o "-h 127.0.0.1 -k $TMP -p 55495 -c fsync=off" -l "$TMP/pg.log" -w start > /dev/null || { echo PG_START_FAILED; tail -n 17 "$TMP/pg.log"; exit 1; }
"$PG/createdb" -h 127.0.0.1 -p 55495 -U infh-dev warcon_issue95_test
export DATABASE_URL="$URL" WARCON_ISSUE95_TEST_DATABASE_URL="$URL"
export ORIGIN=http://127.0.0.1:55496 WARCON_ROLE=all ALLOW_DEMO_SERVER=false
export BETTER_AUTH_SECRET=local_infh_issue95_test_only_long_random_secret_not_prod
export ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64 -w 0)"
export INFH_HTTP_TEST_TOKEN="wck_$(head -c 32 /dev/urandom | base64 -w 0 | tr '+/' '-_' | tr -d '=')"
export WARCON_API_URL=http://127.0.0.1:55496 WARCON_API_KEY="$INFH_HTTP_TEST_TOKEN"
cd "$WARCON"
bun -e 'import {connect,runMigrations} from "./src/lib/server/db/index.ts"; const x=connect(process.env.DATABASE_URL); try { await runMigrations(x.db,"./drizzle"); } finally { await x.client.close(); }' > "$TMP/migrate.log" 2>&1 || { echo MIGRATION_FAILED; tail -n 18 "$TMP/migrate.log"; exit 1; }
bun -e 'import {connect,schema} from "./src/lib/server/db/index.ts"; import {hashToken,tokenHint} from "./src/lib/server/apikeys-core.ts"; const x=connect(process.env.DATABASE_URL); try { await x.db.insert(schema.organizations).values({id:"org-test",name:"Isolated acceptance",slug:"issue95-fixture"}); await x.db.insert(schema.lists).values({id:"list-reserve",orgId:"org-test",kind:"reserve",isDefault:true}); await x.db.insert(schema.apiKeys).values({id:"key-test",orgId:"org-test",label:"Acceptance fixture",keyHash:hashToken(process.env.INFH_HTTP_TEST_TOKEN),hint:tokenHint(process.env.INFH_HTTP_TEST_TOKEN),capabilities:["lists.reserve"],serverIds:null}); } finally { await x.client.close(); }' > "$TMP/seed.log" 2>&1 || { echo SEED_FAILED; tail -n 18 "$TMP/seed.log"; exit 1; }
echo POSTGRESQL_DISPOSABLE_READY
bun --bun ./node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port 55496 --strictPort > "$TMP/warcon.log" 2>&1 &
WEB_PID=$!
READY=0
for i in $(seq 1 50); do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then echo WARCON_PROCESS_EXITED; tail -n 24 "$TMP/warcon.log"; exit 1; fi
  STATUS=$(curl -sS -o "$TMP/probe.json" -w '%{http_code}' -H "Authorization: Bearer $INFH_HTTP_TEST_TOKEN" "http://127.0.0.1:55496/api/orgs/org-test/lists/reserve/entries/guarded" 2>/dev/null || true)
  if [ "$STATUS" = 200 ]; then READY=1; break; fi
  sleep 0.4
done
if [ "$READY" != 1 ]; then echo WARCON_NOT_READY; tail -n 23 "$TMP/warcon.log"; echo LAST_STATUS="$STATUS"; head -c 300 "$TMP/probe.json" 2>/dev/null || true; exit 1; fi
echo WARCON_LOCAL_HTTP_READY
cat > "$TMP/client-test.ts" <<'TS'
import assert from 'node:assert/strict';
import { eq } from '/opt/infh-web-dev/warcon/node_modules/drizzle-orm/index.js';
import { connect, schema } from '/opt/infh-web-dev/warcon/src/lib/server/db/index.ts';
import * as c from '/opt/infh-web-dev/infh-web/lib/wardogs-warcon-client.ts';
const org='org-test', sid='76561198000000071';
const base=process.env.WARCON_API_URL;
let checks=0;
const ok=(value,label)=>{assert.ok(value,label); checks++;console.log('PASS '+label);};
const wrong=await fetch(base+'/api/orgs/'+org+'/lists/reserve/entries/guarded',{headers:{Authorization:'Bearer wck_'+'A'.repeat(43)}});
ok(wrong.status===401,'reject unauthorized API key');
await c.assertWarconGuardedCapability(org);
ok(true,'authenticate valid synthetic key and verify capabilities');
const oldExpiry=new Date('2027-01-01T00:00:00.000Z');
const laterExpiry=new Date('2027-04-01T00:00:00.000Z');
const created=await c.addWarconReservedSlot(org,sid,'synthetic INFH','http_test_original_operation_001',oldExpiry);
ok(created.entry?.expiresAt===oldExpiry.toISOString() && !!created.entry?.id,'ADD persisted expiry and immutable receipt');
const original=created.entry.id;
const replay=await c.addWarconReservedSlot(org,sid,'synthetic INFH','http_test_original_operation_001',laterExpiry);
ok(replay.entry?.id===original && replay.entry?.expiresAt===oldExpiry.toISOString(),'ADD replay returns same entry and actual old expiry');
const patched=await c.patchGuardedWarconExpiry(org,sid,original,oldExpiry.toISOString(),laterExpiry);
ok(patched.entry?.id===original && patched.entry?.expiresAt===laterExpiry.toISOString(),'guarded CAS preserves ID and correct expiry');
let stale=false;
try{await c.patchGuardedWarconExpiry(org,sid,original,oldExpiry.toISOString(),new Date('2027-05-01T00:00:00.000Z'));}catch(e){stale=e.code==='STALE_EXPIRY';}
ok(stale,'stale expiry CAS rejected');
const observed=await c.lookupGuardedWarconEntry(org,sid);
ok(observed?.id===original && observed?.expiresAt===laterExpiry.toISOString(),'exact current lookup');
const db=connect(process.env.DATABASE_URL);
try{
  await db.db.update(schema.listEntries).set({removedAt:new Date(),removal:'expired',removedByName:'expiry'}).where(eq(schema.listEntries.id,original));
  const proof=await c.lookupGuardedWarconEvidence(org,sid,original);
  ok(proof.previous?.id===original && proof.previous?.removal==='expired' && proof.previous?.removedAt && proof.current===null,'exact expiry tombstone from PostgreSQL');
  const replacement=await c.addWarconReservedSlot(org,sid,'synthetic INFH regrant','http_test_replacement_operation_002',laterExpiry);
  const newId=replacement.entry.id;
  ok(newId!==original,'replacement uses new immutable receipt');
  const replacementReplay=await c.addWarconReservedSlot(org,sid,'synthetic INFH regrant','http_test_replacement_operation_002',laterExpiry);
  ok(replacementReplay.entry.id===newId,'lost response replay recovers same replacement');
  const late=await c.removeWarconReservedSlot(org,sid,original);
  ok(late.entryId===original && late.removed===true && (await c.lookupGuardedWarconEntry(org,sid))?.id===newId,'late guarded DELETE preserves replacement');
  const deleted=await c.removeWarconReservedSlot(org,sid,newId);
  ok(deleted.entryId===newId && deleted.removed===true,'guarded DELETE removes exact owned entry');
  await db.db.insert(schema.listEntries).values({id:'manual-http-replacement',listId:'list-reserve',steamId:sid,reason:'manual only',addedByName:'WARCON admin'});
  const manual=(await c.lookupGuardedWarconEntry(org,sid))?.id;
  ok(manual==='manual-http-replacement','manual WARCON entry present');
  await c.removeWarconReservedSlot(org,sid,original);
  ok((await c.lookupGuardedWarconEntry(org,sid))?.id===manual,'old delete cannot remove manual replacement');
  let duplicate=false;
  try{await c.addWarconReservedSlot(org,sid,'forbidden adoption','http_test_other_operation_003',laterExpiry);}catch(e){duplicate=e.code==='DUPLICATE';}
  ok(duplicate,'manual entry not adopted on duplicate');
  ok(c.normalizeWarconSyncState(created.sync)!=='APPLIED','empty synthetic server fanout is not falsely APPLIED');
}finally{await db.client.close();}
console.log('ISSUE95_REAL_HTTP_ACCEPTANCE='+checks+' PASS / 0 FAIL');

TS
bun "$TMP/client-test.ts" || { echo HTTP_CLIENT_FAILED; tail -n 28 "$TMP/warcon.log"; exit 1; }
