// 一次性压测脚本（不入库）：FTS5 trigram 在 20 万轮规模下的建索引/查询/体积
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bench-'));
const file = path.join(dir, 'bench.db');
const db = new DatabaseSync(file);

const N = Number(process.argv[2] || 200000);
const WORDS = ['三级树', '端口冲突', '索引重建', '缓存判定', '左栏', '证据链', '断点续接', '回滚'];
const filler = '把左栏改成三级树，缓存判定改为会话都还在，端口冲突导致启动失败，索引重建耗时统计。';

function sentence(i) {
  const a = WORDS[i % WORDS.length];
  const b = WORDS[(i * 7) % WORDS.length];
  return `第${i}轮：${a} 与 ${b} 的取舍。${filler}${filler.slice(0, 120)}`;
}

db.exec("create virtual table t using fts5(body, tokenize='trigram')");

console.log(`规模: ${N} 轮`);
const t0 = Date.now();
const ins = db.prepare('insert into t(body) values (?)');
db.exec('begin');
for (let i = 0; i < N; i++) {
  ins.run(sentence(i));
  if (i % 50000 === 49999) {
    db.exec('commit');
    db.exec('begin');
  }
}
db.exec('commit');
const tIns = Date.now() - t0;

function probe(sql, arg) {
  const s = Date.now();
  const r = db.prepare(sql).get(arg);
  return { ms: Date.now() - s, n: r.c };
}

const cases = [
  ['3 字 MATCH 三级树', 'select count(*) c from t where t match ?', '三级树'],
  ['4 字 MATCH 端口冲突', 'select count(*) c from t where t match ?', '端口冲突'],
  ['2 字 MATCH 左栏（预期命中 0）', 'select count(*) c from t where t match ?', '左栏'],
  ['2 字 LIKE 左栏（回退）', 'select count(*) c from t where body like ?', '%左栏%'],
];

console.log(`插入耗时: ${tIns} ms`);
for (const [label, sql, arg] of cases) {
  const r = probe(sql, arg);
  console.log(`${label}: ${r.n} 命中, ${r.ms} ms`);
}

const rowBytes = Buffer.byteLength(sentence(0), 'utf8');
db.close();
const size = fs.statSync(file).size;
console.log(`单行正文约 ${rowBytes} 字节`);
console.log(`DB 体积: ${(size / 1024 / 1024).toFixed(1)} MB（含 trigram 索引）`);
console.log(`平均每轮占用: ${(size / N / 1024).toFixed(2)} KB`);
fs.rmSync(dir, { recursive: true, force: true });
