/**
 * Adds ~100 randomly generated transactions to the database.
 *
 *   npm run seed:transactions            -> insert
 *   npm run seed:transactions -- --dry   -> only print the summary, write nothing
 *   npm run seed:transactions:delete     -> delete ONLY the entries created by this script (ids starting with `rec_seed_`)
 *   npm run seed:transactions:delete -- --dry -> show how many would be deleted, delete nothing
 *
 * - Never deletes or overwrites existing data (only INSERTs new `rec_seed_*` documents;
 *   sets organization.yearlyBudget only when it is not set yet).
 * - Nothing is a fixed list of rows: dates, categories, parties, modes and amounts are drawn at random on every run.
 * - Dates: 01 Feb 2026 .. 06 Oct 2026.  Total EXPENSES stay inside the annual budget (about 80-88% of it, e.g. ~85,000 of 1,00,000).
 * - `createdBy` is picked from the users that already exist in the database.
 */
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const COUNT = 100;
const START = new Date('2026-02-01T00:00:00Z');
const END = new Date('2026-10-06T00:00:00Z');
const ANNUAL_BUDGET = 100000;
const ORG_NAME = 'Mission Vikram Prakalp';
const DRY = process.argv.includes('--dry');
const DELETE = process.argv.includes('--delete');

const rnd = (min: number, max: number) => Math.random() * (max - min) + min;
const rint = (min: number, max: number) => Math.floor(rnd(min, max + 1));
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
function weighted<T>(items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of items) { if ((r -= w) <= 0) return v; }
  return items[items.length - 1][0];
}

// ---- vocabulary used to build random entries (not fixed rows) ----
const FIRST = ['Aarav','Vivaan','Aditya','Rohan','Karan','Neha','Priya','Anjali','Sneha','Pooja','Rahul','Amit','Sunita','Meera','Vikas','Deepak','Kavita','Manish','Ritu','Sanjay','Nisha','Arjun','Isha','Harsh','Divya'];
const LAST = ['Sharma','Verma','Gupta','Singh','Maheshwari','Yadav','Joshi','Mehta','Agrawal','Patel','Jain','Mishra','Khandelwal','Rathore','Soni','Bansal','Tiwari','Chouhan'];
const VENDOR_A = ['Shree','Sai','Gajanana','Annapurna','Balaji','Krishna','Om','Laxmi','Maa','Jai'];
const VENDOR_B = ['Enterprises','Stationers','Traders','Caterers','Travels','Printers','Decorators','Sound & Lights','Book Depot','General Store'];

type Cat = {
  nature: 'Income' | 'Expense';
  weight: number;           // how often it is drawn
  share: number;            // relative size of its amount
  min: number;              // minimum amount
  party: 'person' | 'vendor' | 'org';
  vendorKinds?: string[];   // business types that fit this category
  purposes: (() => string)[];
  notes: (() => string)[];
  modes: [('UPI' | 'Cash' | 'Other'), number][];
};
const month = () => pick(['February','March','April','May','June','July','August','September']);
const cats: Cat[] = [
  { nature:'Income', weight:30, share:3, min:300, party:'person',
    purposes:[() => 'Donation received', () => 'Monthly donation', () => 'Education sponsorship donation', () => `Donation for ${pick(['midday meal','study kits','school fees','winter clothes'])}`],
    notes:[() => 'Donation received with thanks.', () => 'Earmarked for student support.', () => ''],
    modes:[['UPI',6],['Cash',3],['Other',1]] },
  { nature:'Income', weight:6, share:6, min:2000, party:'org',
    purposes:[() => 'Grant instalment received', () => 'Sponsorship for annual event', () => 'CSR contribution'],
    notes:[() => 'Received through bank transfer.', () => 'Sponsor acknowledgement sent.'],
    modes:[['Other',6],['UPI',3]] },
  { nature:'Expense', weight:16, share:3, min:200, party:'vendor', vendorKinds:['Stationers','Book Depot','Printers'],
    purposes:[() => 'Study material purchased', () => 'Books and notebooks for students', () => 'Stationery purchase', () => 'Printing of worksheets'],
    notes:[() => 'Bill collected.', () => 'Distributed to students.', () => ''],
    modes:[['UPI',5],['Cash',4],['Other',1]] },
  { nature:'Expense', weight:10, share:5, min:500, party:'vendor', vendorKinds:['Decorators','Sound & Lights','Caterers'],
    purposes:[() => `Event organised by MVP - ${pick(['Annual Day','Sports Day','Science Fair','Awareness Camp','Diwali Celebration'])}`, () => 'Event decoration and sound', () => 'Event refreshments'],
    notes:[() => 'Event expense as approved by trustees.', () => 'Invoice attached.'],
    modes:[['UPI',5],['Cash',3],['Other',2]] },
  { nature:'Expense', weight:8, share:6, min:800, party:'vendor', vendorKinds:['Travels'],
    purposes:[() => `Trip expense - ${pick(['educational visit','museum trip','nature camp','industrial visit'])}`, () => 'Bus hire for student trip', () => 'Trip meals and tickets'],
    notes:[() => 'Trip for students and volunteers.', () => 'Entry tickets and transport.'],
    modes:[['UPI',4],['Cash',4],['Other',2]] },
  { nature:'Expense', weight:10, share:2.5, min:200, party:'vendor', vendorKinds:['General Store','Caterers'],
    purposes:[() => `Midday meal supplies - ${month()}`, () => 'Groceries for meal programme', () => 'Volunteer meeting refreshments'],
    notes:[() => 'Weekly supplies.', () => ''],
    modes:[['UPI',5],['Cash',5]] },
  { nature:'Expense', weight:6, share:2, min:150, party:'vendor', vendorKinds:['Printers','Enterprises','Traders'],
    purposes:[() => 'Fuel and local transport', () => 'Website and internet charges', () => 'Printing of receipts and banners'],
    notes:[() => 'Operational cost.', () => ''],
    modes:[['UPI',6],['Cash',3],['Other',1]] },
];

const randomPerson = () => `${pick(FIRST)} ${pick(LAST)}`;
const randomVendor = (kinds?: string[]) => `${pick(VENDOR_A)} ${pick(kinds && kinds.length ? kinds : VENDOR_B)}`;
const randomOrg = () => `${pick(LAST)} ${pick(['Foundation','Trust','Industries','Charitable Society'])}`;
const partyName = (c: Cat) => (c.party === 'person' ? randomPerson() : c.party === 'vendor' ? randomVendor(c.vendorKinds) : randomOrg());

const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

/** Spread `total` over weights, each at least `min`, rounded to 10 (or 50 for big ones); the last item absorbs rounding drift. */
function distribute(items: { share: number; min: number }[], total: number): number[] {
  const jitter = items.map(i => i.share * rnd(0.5, 1.6));
  const sum = jitter.reduce((a, b) => a + b, 0);
  const amounts = items.map((it, i) => {
    const raw = Math.max(it.min, (jitter[i] / sum) * total);
    return roundTo(raw, raw >= 2000 ? 50 : 10);
  });
  // correct drift so the sum equals total as closely as possible
  let diff = total - amounts.reduce((a, b) => a + b, 0);
  for (let guard = 0; Math.abs(diff) >= 10 && guard < 5000; guard++) {
    const i = rint(0, amounts.length - 1);
    const step = Math.sign(diff) * 10;
    if (amounts[i] + step >= items[i].min) { amounts[i] += step; diff -= step; }
  }
  return amounts;
}

function randomDate(): string {
  const t = START.getTime() + Math.random() * (END.getTime() - START.getTime());
  return new Date(t).toISOString().slice(0, 10);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing in .env');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  try {
    if (DELETE) {
      // Only documents created by this script are touched (id prefix `rec_seed_`); real entries are never matched.
      const where = `collection_name='records' AND id LIKE 'rec\\_seed\\_%' ESCAPE '\\'`;
      const count = Number((await pool.query(`SELECT COUNT(*) AS c FROM app_documents WHERE ${where}`)).rows[0].c);
      console.log(`Found ${count} seeded transactions.`);
      if (DRY || count === 0) { console.log(DRY ? 'Dry run: nothing deleted.' : 'Nothing to delete.'); return; }
      await pool.query(`DELETE FROM app_documents WHERE ${where}`);
      console.log(`Deleted ${count} seeded transactions. All other data was left untouched.`);
      return;
    }

    // Existing data is only READ here.
    const users = (await pool.query(`SELECT data FROM app_documents WHERE collection_name='users'`)).rows.map(r => r.data);
    const creators = users.filter((u: any) => u.status === 'active' && ['Finance Manager', 'Aarthik Pramukh', 'Admin', 'Super Admin'].includes(u.role)).map((u: any) => u.userId);
    if (!creators.length) throw new Error('No active users found in the database to attribute transactions to.');

    const orgRow = (await pool.query(`SELECT data FROM app_documents WHERE collection_name='organization' AND id='mvp_org'`)).rows[0]?.data;
    const existingExpense = (await pool.query(`SELECT COALESCE(SUM((data->>'amount')::numeric),0) AS s FROM app_documents WHERE collection_name='records' AND data->>'transactionNature'='Expense' AND data->>'status' IS DISTINCT FROM 'deleted' AND data->>'transactionDate' >= '2026-01-01'`)).rows[0].s;
    const budget = Number(orgRow?.yearlyBudget) > 0 ? Number(orgRow.yearlyBudget) : ANNUAL_BUDGET;

    // Choose categories for the 100 rows (guarantee a few of each), then size them.
    const chosen: Cat[] = cats.map(c => c);                          // one of each
    while (chosen.length < COUNT) chosen.push(weighted(cats.map(c => [c, c.weight] as [Cat, number])));
    chosen.sort(() => Math.random() - 0.5);

    // Spend target: 80-88% of the annual budget, minus anything already spent this year.
    const spendTarget = Math.max(0, Math.round(budget * rnd(0.88, 0.100) / 10) * 10 - Number(existingExpense));
    const expenseCats = chosen.filter(c => c.nature === 'Expense');
    const incomeCats = chosen.filter(c => c.nature === 'Income');
    const expenseAmts = distribute(expenseCats, spendTarget);
    const incomeTarget = Math.round(spendTarget * rnd(1.15, 1.4) / 10) * 10;   // income comfortably above spending
    const incomeAmts = distribute(incomeCats, incomeTarget);

    let ei = 0, ii = 0;
    const stamp = Date.now();
    const rows = chosen.map((c, n) => {
      const amount = c.nature === 'Expense' ? expenseAmts[ei++] : incomeAmts[ii++];
      const date = randomDate();
      const party = partyName(c);
      const iso = `${date}T${String(rint(8, 19)).padStart(2, '0')}:${String(rint(0, 59)).padStart(2, '0')}:00.000Z`;
      return {
        id: `rec_seed_${stamp}_${String(n + 1).padStart(3, '0')}`,
        transactionNature: c.nature,
        moneySender: c.nature === 'Income' ? party : ORG_NAME,
        moneyReceiver: c.nature === 'Income' ? ORG_NAME : party,
        transactionType: weighted(c.modes),
        amount,
        purpose: pick(c.purposes)(),
        transactionDate: date,
        notes: pick(c.notes)(),
        createdBy: pick(creators),
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      };
    }).sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

    const sum = (nat: string) => rows.filter(r => r.transactionNature === nat).reduce((s, r) => s + r.amount, 0);
    const exp = sum('Expense'), inc = sum('Income');
    console.log(`Generated ${rows.length} transactions (${rows[0].transactionDate} -> ${rows[rows.length - 1].transactionDate})`);
    console.log(`  Income : ₹${inc.toLocaleString('en-IN')}  (${rows.filter(r => r.transactionNature === 'Income').length} entries)`);
    console.log(`  Expense: ₹${exp.toLocaleString('en-IN')}  (${rows.filter(r => r.transactionNature === 'Expense').length} entries)`);
    console.log(`  Annual budget ₹${budget.toLocaleString('en-IN')}; already spent before this run ₹${Number(existingExpense).toLocaleString('en-IN')}; total used after = ₹${(exp + Number(existingExpense)).toLocaleString('en-IN')}`);
    if (exp + Number(existingExpense) > budget) throw new Error('Generated expenses would exceed the annual budget - aborting, nothing written.');

    if (DRY) { console.log('Dry run: nothing written.'); return; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        await client.query(
          `INSERT INTO app_documents (collection_name, id, data) VALUES ('records', $1, $2::jsonb) ON CONFLICT (collection_name, id) DO NOTHING`,
          [r.id, JSON.stringify(r)]
        );
      }
      if (!orgRow) {
        await client.query(
          `INSERT INTO app_documents (collection_name, id, data) VALUES ('organization','mvp_org',$1::jsonb) ON CONFLICT DO NOTHING`,
          [JSON.stringify({ id: 'mvp_org', organizationName: 'MVP-Ledger', createdAt: new Date().toISOString(), yearlyBudget: ANNUAL_BUDGET })]
        );
      } else if (!(Number(orgRow.yearlyBudget) > 0)) {
        await client.query(
          `UPDATE app_documents SET data = data || $1::jsonb, updated_at = now() WHERE collection_name='organization' AND id='mvp_org'`,
          [JSON.stringify({ yearlyBudget: ANNUAL_BUDGET })]
        );
      }
      await client.query('COMMIT');
      console.log('Done. Existing data was left untouched.');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('Seed failed:', e.message || e); process.exit(1); });
