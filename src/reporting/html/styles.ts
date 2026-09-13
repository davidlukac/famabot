/**
 * The browse/serve page's CSS, as a plain string — kept as a TS export
 * (rather than a real .css asset) so plain `tsc` needs no bundler step to get
 * it into `dist/`. `pageShell()` in `shell.ts` wraps it in `<style>…</style>`.
 *
 * `${live}` is `true` when the page auto-refreshes (`famabot serve`), which
 * turns on the topbar's pulsing "live" dot.
 */
export function pageStyles(live: boolean): string {
  return `
  :root{
    --bg:#0e1014; --panel:#161a21; --panel-2:#1c212b; --border:#282e3a;
    --text:#e7e9ee; --muted:#8b93a1; --faint:#5f6773;
    --accent:#4f8cff; --accent-ink:#fff;
    --good:#3ecf8e; --ok:#f2b544; --weak:#f2668b; --violet:#a78bfa;
    --chip:#232a37;
    color-scheme:dark;
  }
  @media (prefers-color-scheme:light){:root{
    --bg:#f7f8fa; --panel:#ffffff; --panel-2:#eef1f5; --border:#e2e6ec;
    --text:#1a1d23; --muted:#6b7280; --faint:#9aa1ac;
    --accent:#2563eb; --good:#15a862; --ok:#c4870a; --weak:#dc2f5c; --violet:#7c56d6;
    --chip:#eef1f5;
    color-scheme:light;
  }}
  *{box-sizing:border-box}
  body{margin:0;padding:0 22px 40px;background:var(--bg);color:var(--text);
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--accent);text-decoration:none}
  .muted{color:var(--muted)}

  .topbar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:14px;
    padding:14px 0 12px;background:var(--bg);border-bottom:1px solid var(--border)}
  .brand{font-weight:700;font-size:14px;letter-spacing:.02em;display:flex;align-items:center;gap:7px}
  .brand .dot{width:7px;height:7px;border-radius:50%;background:var(--good);
    ${live ? "animation:pulse 2.4s ease-in-out infinite" : ""}}
  #q{flex:0 1 320px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;
    padding:7px 11px;color:var(--text);font:inherit;outline:none}
  #q:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
  .count{margin-left:auto;color:var(--muted);font-size:12px}
  .count b{color:var(--text)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  .filters{display:flex;flex-wrap:wrap;gap:16px 26px;background:var(--panel);
    border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:16px 0}
  .fgroup{display:flex;flex-direction:column;gap:8px}
  .flabel{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
  .frow{display:flex;flex-wrap:wrap;align-items:center;gap:7px 14px}
  .chk{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;color:var(--text)}
  .chk input{margin:0;accent-color:var(--accent);width:14px;height:14px}
  select,input[type=date],input[type=number]{background:var(--panel-2);border:1px solid var(--border);
    border-radius:7px;padding:6px 9px;color:var(--text);font:inherit;outline:none}
  select:focus,input:focus{border-color:var(--accent)}
  .btn{background:var(--panel-2);border:1px solid var(--border);border-radius:7px;color:var(--muted);
    padding:6px 11px;font:inherit;cursor:pointer;transition:color .12s,background .12s}
  .btn:hover{color:var(--text)}
  .btn.on{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  .seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .seg button{border:0;border-right:1px solid var(--border);background:var(--panel-2);color:var(--muted);
    padding:6px 11px;font:inherit;cursor:pointer;transition:color .12s,background .12s}
  .seg button:last-child{border-right:0}
  .seg button:hover:not(.on){color:var(--text)}
  .seg button.on{background:var(--accent);color:var(--accent-ink)}

  .tablewrap{border:1px solid var(--border);border-radius:12px;overflow:auto;max-height:calc(100vh - 250px)}
  table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
  thead th{position:sticky;top:0;z-index:2;background:var(--panel);color:var(--muted);
    text-align:left;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
    padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none}
  thead th:hover{color:var(--text)}
  thead th .ar{margin-left:5px;color:var(--accent);font-size:9px}
  tbody td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--panel-2)}
  tr.gone{opacity:.5}
  tr.gone .ttl{text-decoration:line-through}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .num.t{color:var(--muted)}
  .clip{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .why .clip{color:var(--muted);font-size:11.5px}
  .ttlcell{min-width:16ch}
  a.ttl{color:var(--text);font-weight:500}
  a.ttl:hover{color:var(--accent)}
  .sc{display:inline-block;min-width:40px;text-align:center;padding:2px 7px;border-radius:999px;
    font-family:ui-monospace,monospace;font-size:11px;font-weight:700}
  .sc-g{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
  .sc-o{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
  .sc-w{background:color-mix(in srgb,var(--weak) 16%,transparent);color:var(--weak)}
  .ph{display:inline-block;padding:2px 9px;border-radius:999px;font-size:10.5px;font-weight:600;
    background:var(--chip);color:var(--muted);text-transform:capitalize}
  .ph-candidate{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
  .ph-contacted{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
  .ph-visit_scheduled,.ph-visited{background:color-mix(in srgb,var(--violet) 18%,transparent);color:var(--violet)}
  .ph-accepted{background:color-mix(in srgb,var(--good) 28%,transparent);color:var(--good)}
  .ph-rejected,.ph-declined{color:var(--faint)}
  .bd{display:inline-block;font-size:10px;padding:1px 4px;border-radius:4px;margin-right:5px}
  .bd-chg{background:color-mix(in srgb,var(--accent) 20%,transparent);color:var(--accent)}
  .bd-ext{background:color-mix(in srgb,var(--violet) 20%,transparent);color:var(--violet)}
  .bd-gone{background:color-mix(in srgb,var(--weak) 20%,transparent);color:var(--weak)}
  .fl{color:var(--ok);font-size:11.5px;font-weight:700;white-space:nowrap}
  tbody tr{cursor:pointer}

  .ov{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-start;justify-content:center;
    padding:5vh 16px 16px;overflow:auto;background:color-mix(in srgb,#000 58%,transparent)}
  .ov[hidden]{display:none}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;width:100%;
    max-width:780px;box-shadow:0 24px 70px rgba(0,0,0,.45);overflow:hidden}
  .mhead{position:sticky;top:0;display:flex;gap:12px;align-items:flex-start;padding:16px 18px;
    background:var(--panel);border-bottom:1px solid var(--border)}
  .mhead h2{margin:0;font-size:15px;line-height:1.35;font-weight:600;flex:1}
  .mhead h2 a{color:var(--text)}.mhead h2 a:hover{color:var(--accent)}
  .mclose{border:1px solid var(--border);background:var(--panel-2);color:var(--muted);border-radius:8px;
    width:30px;height:30px;font-size:15px;cursor:pointer;flex:none}
  .mclose:hover{color:var(--text)}
  .mbody{padding:16px 18px;display:flex;flex-direction:column;gap:16px}
  .mchips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .mchips .pill{background:var(--panel-2);border:1px solid var(--border);border-radius:999px;
    padding:3px 10px;font-size:12px;color:var(--muted)}
  .mchips .pill b{color:var(--text);font-weight:600}
  .sec{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;
    color:var(--muted);margin-bottom:7px}
  .reason{font-size:14px;line-height:1.65;background:var(--panel-2);border:1px solid var(--border);
    border-radius:10px;padding:14px 16px}
  .mlist{margin:0;padding-left:18px;font-size:13px;line-height:1.6}
  .mlist.flags li{color:var(--ok)}
  .kv{display:grid;grid-template-columns:max-content 1fr;gap:5px 16px;font-size:12.5px}
  .kv dt{color:var(--muted)}.kv dd{margin:0}
  .mlinks a{display:block;font-size:12.5px;word-break:break-all;margin-bottom:3px}
  .desc{white-space:pre-wrap;font-size:12.5px;line-height:1.6;color:var(--muted);
    background:var(--panel-2);border:1px solid var(--border);border-radius:10px;
    padding:12px 14px;max-height:320px;overflow:auto}
  .mfoot{display:flex;gap:10px;align-items:center;padding:14px 18px;border-top:1px solid var(--border)}
  .mfoot .id{color:var(--faint);font-size:11px;font-family:ui-monospace,monospace;margin-left:auto}
  .mopen{background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;
    padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
  .mnav{color:var(--muted);font-size:11px}
`;
}
