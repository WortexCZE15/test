(function(){
"use strict";

/* Veřejné údaje projektu Supabase. Publishable klíč smí být v kódu webu,
   přístup k datům hlídají pravidla RLS v supabase-setup.sql. */
var SUPABASE_URL = "https://aeorpvnzfryqpghsoofu.supabase.co";
var SUPABASE_KEY = "sb_publishable_OHuJ1ndmUhl3aoFx3P1j-g_TZeJ45KD";

var app = document.getElementById("app");
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* view: loading | auth | home | lock | play | edit */
var S = { view:"loading", authTab:"login", session:null, me:null, profile:null,
          quizzes:[], listError:null, msg:null, play:null, edit:null, lockFor:null, filter:"", busy:false };

/* ---------- šifrování (heslo -> PBKDF2 -> AES-GCM) ---------- */
var enc = new TextEncoder(), dec = new TextDecoder();
function b64(buf){ var s="", b=new Uint8Array(buf); for (var i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function unb64(s){ var b=atob(s), u=new Uint8Array(b.length); for (var i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; }
function deriveKey(pw, salt){
  return crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]).then(function(base){
    return crypto.subtle.deriveKey({name:"PBKDF2", salt:salt, iterations:250000, hash:"SHA-256"}, base, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
  });
}
function encrypt(obj, pw){
  var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  return deriveKey(pw, salt).then(function(key){
    return crypto.subtle.encrypt({name:"AES-GCM", iv:iv}, key, enc.encode(JSON.stringify(obj)));
  }).then(function(ct){ return {salt:b64(salt), iv:b64(iv), ct:b64(ct)}; });
}
function decrypt(blob, pw){
  return deriveKey(pw, unb64(blob.salt)).then(function(key){
    return crypto.subtle.decrypt({name:"AES-GCM", iv:unb64(blob.iv)}, key, unb64(blob.ct));
  }).then(function(pt){ return JSON.parse(dec.decode(pt)); });
}

/* ---------- pomocné ---------- */
function el(tag, attrs, kids){
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs){
    var v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else if (k.slice(0,2) === "on") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  (kids||[]).forEach(function(c){ if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return n;
}
function shuffle(a){ a=a.slice(); for (var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=a[i]; a[i]=a[j]; a[j]=t; } return a; }
function msgEl(){ return S.msg ? el("p",{class:"msg "+S.msg.kind, text:S.msg.text, role:"status"}) : null; }
function render(){
  var a = document.activeElement, id = a && a.id && a.tagName === "INPUT" ? a.id : null, sel = id ? [a.selectionStart, a.selectionEnd] : null;
  app.replaceChildren.apply(app, view().filter(Boolean));
  if (id){ var n = document.getElementById(id); if (n){ n.focus(); try { n.setSelectionRange(sel[0], sel[1]); } catch(e) {} } }
}
function go(v, keepMsg){ S.view = v; if (!keepMsg) S.msg = null; render(); window.scrollTo(0,0); }
function focusLater(id){ setTimeout(function(){ var x=document.getElementById(id); if (x) x.focus(); },0); }
function plural(n, one, few, many){ return n===1 ? one : (n>=2 && n<=4) ? few : many; }
function err(kind, text){ S.msg = {kind:kind, text:text}; render(); }
function dbErrText(e){
  var m = (e && (e.message || e.error_description)) || "";
  if (/JWT|expired|not authenticated/i.test(m)) return "Přihlášení vypršelo. Odhlas se a přihlas znovu.";
  if (/row-level security|permission denied/i.test(m)) return "Na tohle nemáš oprávnění.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Nepovedlo se spojit s databází. Zkontroluj internet a zkus to znovu.";
  return "Něco se nepovedlo: " + (m || "neznámá chyba") + ".";
}
function authErrText(e){
  var m = (e && e.message) || "";
  if (/Invalid login credentials/i.test(m)) return "Špatný e-mail nebo heslo.";
  if (/Email not confirmed/i.test(m)) return "E-mail ještě není potvrzený. Klikni na odkaz, který ti přišel do schránky.";
  if (/already registered|already been registered/i.test(m)) return "Tenhle e-mail už je zaregistrovaný. Přihlas se.";
  if (/Password should be/i.test(m)) return "Heslo je moc slabé. Musí mít aspoň 6 znaků.";
  if (/rate limit/i.test(m)) return "Moc pokusů za sebou. Chvíli počkej a zkus to znovu.";
  if (/valid email|invalid format/i.test(m)) return "Tohle nevypadá jako platný e-mail.";
  if (/Database error saving new user/i.test(m)) return "Registrace se nepovedla. Nejspíš je přezdívka obsazená, zkus jinou.";
  return "Nepovedlo se to: " + (m || "neznámá chyba") + ".";
}

/* ---------- obrazovky ---------- */
function view(){
  switch (S.view){
    case "auth": return authView();
    case "home": return homeView();
    case "lock": return [lockView()];
    case "play": return playView();
    case "edit": return editView();
    default: return [el("div",{class:"panel"},[el("h2",{text:"Načítám kvízy…"})])];
  }
}

function authView(){
  var reg = S.authTab === "register";
  var email = el("input",{type:"email",id:"au-email",autocomplete:"email",required:true});
  var nick = reg ? el("input",{type:"text",id:"au-nick",maxlength:"30",autocomplete:"nickname"}) : null;
  var pw = el("input",{type:"password",id:"au-pw",autocomplete: reg ? "new-password" : "current-password",required:true});
  var btn = el("button",{class:"btn",type:"submit",text: reg ? "Zaregistrovat se" : "Přihlásit se",disabled:S.busy});

  var form = el("form",{class:"panel",onsubmit:function(e){ e.preventDefault(); reg ? doRegister(email.value, nick.value, pw.value) : doLogin(email.value, pw.value); }},[
    el("span",{class:"brand",text:"Kvízy"}),
    el("h1",{text: reg ? "Vytvoř si účet" : "Přihlas se"}),
    el("p",{class:"muted",text:"Po přihlášení uvidíš všechny kvízy, které lidi vytvořili, a můžeš dělat vlastní."}),
    el("div",{class:"tabs",role:"group","aria-label":"Přihlášení nebo registrace"},[
      el("button",{type:"button",class:"tab","aria-pressed":String(!reg),text:"Přihlášení",onclick:function(){ S.authTab="login"; S.msg=null; render(); }}),
      el("button",{type:"button",class:"tab","aria-pressed":String(reg),text:"Registrace",onclick:function(){ S.authTab="register"; S.msg=null; render(); }})
    ]),
    el("div",{class:"field"},[el("label",{class:"label",for:"au-email",text:"E-mail"}), email]),
    reg ? el("div",{class:"field"},[el("label",{class:"label",for:"au-nick",text:"Přezdívka"}), nick, el("p",{class:"muted small",text:"Tohle jméno uvidí ostatní u tvých kvízů."})]) : null,
    el("div",{class:"field"},[el("label",{class:"label",for:"au-pw",text:"Heslo"}), pw, reg ? el("p",{class:"muted small",text:"Aspoň 6 znaků."}) : null]),
    msgEl(),
    el("div",{class:"row"},[btn])
  ]);
  return [form];
}

function doLogin(email, pw){
  S.busy = true; S.msg = null; render();
  sb.auth.signInWithPassword({email:email.trim(), password:pw}).then(function(r){
    S.busy = false;
    if (r.error) return err("err", authErrText(r.error));
    /* zbytek dořeší onAuthStateChange */
  });
}

function doRegister(email, nick, pw){
  nick = (nick||"").trim();
  if (nick.length < 2) return err("err","Přezdívka musí mít aspoň 2 znaky.");
  if (pw.length < 6) return err("err","Heslo musí mít aspoň 6 znaků.");
  S.busy = true; S.msg = null; render();
  sb.rpc("nickname_taken", {n:nick}).then(function(r){
    if (r.error){ S.busy = false; return err("err", dbErrText(r.error)); }
    if (r.data === true){ S.busy = false; return err("err","Tuhle přezdívku už někdo má. Vyber si jinou."); }
    return sb.auth.signUp({email:email.trim(), password:pw, options:{data:{nickname:nick}, emailRedirectTo: location.href.split("#")[0]}}).then(function(r2){
      S.busy = false;
      if (r2.error) return err("err", authErrText(r2.error));
      if (!r2.data.session){
        S.authTab = "login";
        S.msg = {kind:"ok", text:"Účet je vytvořený. Do e-mailu ti přišel odkaz na potvrzení, klikni na něj a pak se přihlas."};
        render();
      }
    });
  });
}

function logout(){ sb.auth.signOut(); }

/* ---------- seznam ---------- */
function loadQuizzes(){
  return sb.from("quizzes")
    .select("id,title,question_count,locked,updated_at,author_id,profiles(nickname)")
    .order("updated_at",{ascending:false})
    .limit(500)
    .then(function(r){
      if (r.error){ S.listError = dbErrText(r.error); S.quizzes = []; }
      else { S.listError = null; S.quizzes = r.data || []; }
      if (S.view === "home") render();
    });
}

function homeView(){
  var list = S.quizzes, f = S.filter.trim().toLowerCase();
  var shown = f ? list.filter(function(q){ return (q.title||"").toLowerCase().indexOf(f) >= 0 || ((q.profiles && q.profiles.nickname)||"").toLowerCase().indexOf(f) >= 0; }) : list;
  var search = el("input",{type:"search",id:"search",placeholder:"Hledat podle názvu nebo autora","aria-label":"Hledat kvízy",oninput:function(e){ S.filter = e.target.value; render(); }});
  search.value = S.filter;

  var cards = S.listError ? el("p",{class:"msg err",text:S.listError}) :
    shown.length ? el("div",{class:"cards"}, shown.map(function(q){
      var mine = q.author_id === S.me, n = q.question_count || 0, author = (q.profiles && q.profiles.nickname) || "Neznámý";
      var card = el("button",{class:"card",onclick:function(){ openQuiz(q.id, "play"); }},[
        el("span",{class:"txt"},[
          el("strong",{text:q.title||"Bez názvu"}),
          el("span",{class:"muted small",text:author+" · "+n+" "+plural(n,"otázka","otázky","otázek")}),
          (mine || q.locked) ? el("span",{class:"row",style:"gap:6px"},[ mine ? el("span",{class:"pill mine",text:"Tvůj"}) : null, q.locked ? el("span",{class:"pill",text:"Na heslo"}) : null ]) : null
        ]),
        el("span",{class:"go",text:"Hrát"})
      ]);
      var actions = mine ? el("div",{class:"row",style:"gap:14px;padding-left:4px"},[
        el("button",{class:"btn link small",text:"Upravit",onclick:function(){ openQuiz(q.id, "edit"); }}),
        el("button",{class:"btn link small",style:"color:var(--bad)",text:"Smazat",onclick:function(e){ confirmDelete(e.currentTarget, q.id); }})
      ]) : null;
      return el("div",{class:"cardwrap"},[card, actions]);
    })) : el("p",{class:"muted",text: list.length ? "Nic takového tu není." : "Zatím tu nikdo žádný kvíz nevytvořil. Buď první!"});

  return [
    el("div",{class:"top"},[
      el("div",{},[el("span",{class:"label",text:"Ahoj, "+(S.profile ? S.profile.nickname : "")}), el("h1",{text:"Všechny kvízy"})]),
      el("div",{class:"row"},[
        el("button",{class:"btn",text:"Nový kvíz",onclick:function(){ openEditor(null, [], ""); }}),
        el("button",{class:"btn ghost",text:"Odhlásit",onclick:logout})
      ])
    ]),
    msgEl(),
    list.length > 3 ? search : null,
    cards
  ];
}

function confirmDelete(btn, id){
  if (btn.dataset.armed){
    btn.disabled = true;
    sb.from("quizzes").delete().eq("id", id).then(function(r){
      if (r.error) return err("err", dbErrText(r.error));
      S.quizzes = S.quizzes.filter(function(q){ return q.id !== id; });
      err("ok","Kvíz smazán.");
    });
  } else {
    btn.dataset.armed = "1"; btn.textContent = "Opravdu smazat?";
    setTimeout(function(){ if (btn.isConnected){ delete btn.dataset.armed; btn.textContent = "Smazat"; } }, 4000);
  }
}

function openQuiz(id, then){
  sb.from("quizzes").select("id,title,questions,enc,author_id").eq("id", id).single().then(function(r){
    if (r.error) return err("err", dbErrText(r.error));
    var q = r.data;
    if (q.enc){ S.lockFor = {quiz:q, then:then}; go("lock"); return; }
    if (then === "edit") openEditor(q, q.questions || [], ""); else startPlay(q, q.questions || []);
  });
}

/* ---------- zámek ---------- */
function lockView(){
  var L = S.lockFor, q = L.quiz;
  var input = el("input",{type:"password",id:"pw",autocomplete:"off","aria-label":"Heslo ke kvízu"});
  var btn = el("button",{class:"btn",type:"submit",text:"Odemknout"});
  focusLater("pw");
  return el("form",{class:"panel",onsubmit:function(e){
    e.preventDefault(); btn.disabled = true;
    decrypt(q.enc, input.value).then(function(qs){
      S.msg = null;
      if (L.then === "edit") openEditor(q, qs, input.value); else startPlay(q, qs);
    }, function(){ err("err","Špatné heslo. Zkus to znovu."); focusLater("pw"); });
  }},[
    el("span",{class:"label",text:"Zamčený kvíz"}),
    el("h2",{text:q.title}),
    el("p",{class:"muted small",text:"Tenhle kvíz je na heslo. Zeptej se autora."}),
    el("div",{class:"row",style:"flex-wrap:nowrap;width:100%"},[input, btn]),
    msgEl(),
    el("div",{},[el("button",{class:"btn link",type:"button",text:"Zpět na seznam",onclick:function(){ go("home"); }})])
  ]);
}

/* ---------- hraní ---------- */
function startPlay(q, questions){
  S.play = { title:q.title, qs:questions, order:shuffle(questions.map(function(_,i){ return i; })), i:0, score:0, picked:null, opts:null };
  prep(); go("play");
}
function prep(){ var P = S.play; P.opts = P.i < P.order.length ? shuffle([0,1,2]) : null; P.picked = null; }

function playView(){
  var P = S.play;
  var head = el("div",{class:"top"},[el("h1",{text:P.title||"Kvíz"}), el("button",{class:"btn link",text:"Zpět na seznam",onclick:function(){ go("home"); }})]);
  if (!P.qs.length) return [head, el("div",{class:"panel"},[el("h2",{text:"Tenhle kvíz je zatím prázdný"})])];
  if (P.i >= P.order.length){
    var pct = Math.round(P.score / P.order.length * 100);
    return [head, el("div",{class:"panel"},[
      el("span",{class:"label",text:"Hotovo"}),
      el("div",{class:"score",text:P.score+" / "+P.order.length}),
      el("p",{class:"muted",text: pct===100 ? "Všechno správně. Paráda!" : pct>=70 ? "Dobrý, "+pct+" % správně." : pct+" % správně. Zkus to ještě jednou."}),
      el("div",{class:"row"},[el("button",{class:"btn",text:"Znovu od začátku",onclick:function(){ P.order=shuffle(P.order); P.i=0; P.score=0; prep(); render(); }}), el("button",{class:"btn ghost",text:"Vybrat jiný kvíz",onclick:function(){ go("home"); }})])
    ])];
  }
  var q = P.qs[P.order[P.i]], letters = ["A","B","C"];
  var answers = el("div",{class:"answers"}, P.opts.map(function(ai, pos){
    var cls = "ans";
    if (P.picked !== null){ if (ai === q.correct) cls += " good"; else if (ai === P.picked) cls += " bad"; }
    return el("button",{class:cls,disabled:P.picked !== null,onclick:function(){ if (P.picked !== null) return; P.picked = ai; if (ai === q.correct) P.score++; render(); }},
      [el("span",{class:"letter",text:letters[pos]}), el("span",{text:q.a[ai]})]);
  }));
  return [head, el("div",{class:"panel"},[
    el("span",{class:"label",text:"Otázka "+(P.i+1)+" z "+P.order.length}),
    el("div",{class:"progress","aria-hidden":"true"},[el("i",{style:"width:"+(P.i/P.order.length*100)+"%"})]),
    el("h2",{text:q.q}),
    answers,
    P.picked !== null ? el("p",{class:"msg "+(P.picked===q.correct?"ok":"err"),role:"status",text: P.picked===q.correct ? "Správně!" : "Špatně. Správná odpověď je zvýrazněná zeleně."}) : null,
    el("div",{class:"row",style:"justify-content:space-between"},[
      el("span",{class:"muted small",text:"Skóre: "+P.score}),
      P.picked !== null ? el("button",{class:"btn",text: P.i+1 < P.order.length ? "Další otázka" : "Zobrazit výsledek",onclick:function(){ P.i++; prep(); render(); }}) : null
    ])
  ])];
}

/* ---------- úpravy ---------- */
function openEditor(q, questions, pw){
  S.edit = { id: q ? q.id : null, title: q ? q.title : "", pw: pw,
             questions: questions.map(function(x){ return {q:x.q, a:x.a.slice(), correct:x.correct}; }) };
  go("edit");
}

function parseBulk(text){
  var blocks = text.replace(/\r/g,"").split(/\n\s*\n/), out = [], errs = [];
  blocks.forEach(function(b, bi){
    var lines = b.split("\n").map(function(s){ return s.trim(); }).filter(Boolean);
    if (!lines.length) return;
    if (lines.length !== 4){ errs.push("Blok "+(bi+1)+" má "+(lines.length-1)+" odpovědí místo 3."); return; }
    var correct = 0, a = lines.slice(1).map(function(s, i){ if (s[0] === "*"){ correct = i; return s.slice(1).trim(); } return s; });
    out.push({q:lines[0], a:a, correct:correct});
  });
  return {qs:out, errs:errs};
}

function editView(){
  var D = S.edit;
  var title = el("input",{type:"text",id:"ed-title",maxlength:"80",placeholder:"Např. Zeměpis – hlavní města",oninput:function(e){ D.title = e.target.value; }});
  title.value = D.title;
  var pw = el("input",{type:"password",id:"ed-pw",autocomplete:"new-password",placeholder:"Nech prázdné, když má být kvíz bez hesla",oninput:function(e){ D.pw = e.target.value; }});
  pw.value = D.pw;

  var list = D.questions.length ? el("ol",{class:"qlist"}, D.questions.map(function(q, i){
    return el("li",{},[
      el("div",{class:"txt"},[el("strong",{text:(i+1)+". "+q.q}), el("div",{class:"small muted"}, q.a.map(function(a, ai){ return el("div",{class: ai===q.correct ? "ok" : "", text:(ai===q.correct?"✓ ":"· ")+a}); }))]),
      el("button",{class:"btn danger",text:"Smazat","aria-label":"Smazat otázku "+(i+1),onclick:function(){ D.questions.splice(i,1); render(); }})
    ]);
  })) : el("p",{class:"muted",text:"Zatím žádné otázky. Přidej první níž."});

  var nq = el("input",{type:"text",id:"new-q",placeholder:"Např. Kolik je 7 × 8?"});
  var na = [0,1,2].map(function(i){ return el("input",{type:"text",id:"new-a"+i,placeholder:"Odpověď "+"ABC"[i]}); });
  var nr = [0,1,2].map(function(i){ return el("input",{type:"radio",name:"new-correct",id:"new-c"+i,"aria-label":"Odpověď "+"ABC"[i]+" je správná",checked:i===0}); });
  var addForm = el("form",{class:"panel",onsubmit:function(e){
    e.preventDefault();
    var a = na.map(function(x){ return x.value.trim(); });
    if (!nq.value.trim() || a.some(function(x){ return !x; })) return err("err","Vyplň otázku a všechny 3 odpovědi.");
    var c = nr.findIndex(function(r){ return r.checked; });
    D.questions.push({q:nq.value.trim(), a:a, correct:c<0?0:c});
    err("ok","Otázka přidaná. Nezapomeň uložit."); focusLater("new-q");
  }},[
    el("h2",{text:"Přidat otázku"}),
    el("div",{class:"field"},[el("label",{class:"label",for:"new-q",text:"Otázka"}), nq]),
    el("div",{class:"field"},[el("span",{class:"label",text:"Odpovědi (puntík = správná)"})].concat(na.map(function(inp,i){ return el("div",{class:"opt"},[nr[i], inp]); }))),
    el("div",{class:"row"},[el("button",{class:"btn ghost",type:"submit",text:"Přidat do seznamu"})])
  ]);

  var bulk = el("textarea",{id:"bulk",placeholder:"Hlavní město Francie?\n*Paříž\nLyon\nMarseille\n\nKolik je 7 × 8?\n54\n*56\n58"});
  var bulkPanel = el("div",{class:"panel"},[
    el("h2",{text:"Nahrát víc otázek najednou"}),
    el("p",{class:"muted small",text:"Na první řádek otázku, pod ni 3 odpovědi. Správnou označ hvězdičkou *. Mezi otázkami nech prázdný řádek."}),
    bulk,
    el("div",{class:"row"},[el("button",{class:"btn ghost",text:"Přidat z textu",onclick:function(){
      var r = parseBulk(bulk.value);
      D.questions = D.questions.concat(r.qs);
      err(r.errs.length ? "err" : "ok", r.errs.length ? "Přidáno "+r.qs.length+". "+r.errs.join(" ") : "Přidáno "+r.qs.length+" "+plural(r.qs.length,"otázka","otázky","otázek")+". Nezapomeň uložit.");
    }})])
  ]);

  var saveBtn = el("button",{class:"btn",text:"Uložit kvíz",onclick:function(){ saveQuiz(saveBtn); }});
  return [
    el("div",{class:"top"},[el("h1",{text: D.id ? "Upravit kvíz" : "Nový kvíz"}), el("button",{class:"btn link",text:"Zpět bez uložení",onclick:function(){ go("home"); }})]),
    el("div",{class:"panel"},[
      el("div",{class:"field"},[el("label",{class:"label",for:"ed-title",text:"Název kvízu"}), title]),
      el("div",{class:"field"},[el("label",{class:"label",for:"ed-pw",text:"Heslo (nepovinné)"}), pw,
        el("p",{class:"muted small",text:"S heslem uvidí ostatní v seznamu jen název. Otázky se uloží zašifrované a odemkne je jen ten, kdo zná heslo."})]),
      el("span",{class:"label",text:"Otázky ("+D.questions.length+")"}),
      list
    ]),
    addForm,
    bulkPanel,
    el("div",{class:"panel"},[msgEl(), el("div",{class:"row"},[saveBtn])])
  ];
}

function saveQuiz(btn){
  var D = S.edit;
  if (!D.title.trim()){ err("err","Dej kvízu název."); return focusLater("ed-title"); }
  if (!D.questions.length) return err("err","Přidej aspoň jednu otázku.");
  if (D.pw && D.pw.length < 4) return err("err","Heslo musí mít aspoň 4 znaky, nebo ho nech prázdné.");
  btn.disabled = true; btn.textContent = "Ukládám…";
  var row = {title:D.title.trim(), question_count:D.questions.length, updated_at:new Date().toISOString()};
  var ready = D.pw
    ? encrypt(D.questions, D.pw).then(function(blob){ row.enc = blob; row.questions = null; return row; })
    : Promise.resolve((row.questions = D.questions, row.enc = null, row));
  ready.then(function(r){
    return D.id ? sb.from("quizzes").update(r).eq("id", D.id) : sb.from("quizzes").insert(r);
  }).then(function(res){
    if (res.error) throw res.error;
    S.msg = {kind:"ok", text:"Kvíz „"+D.title.trim()+"“ je uložený a ostatní ho uvidí v seznamu."};
    go("home", true);
    loadQuizzes();
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "Uložit kvíz";
    err("err", dbErrText(e));
  });
}

/* ---------- start ---------- */
function onSession(session){
  S.session = session;
  if (!session){ S.me = null; S.profile = null; S.quizzes = []; if (S.view !== "auth") go("auth", true); return; }
  if (S.me === session.user.id && S.view !== "loading" && S.view !== "auth") return;
  S.me = session.user.id;
  sb.from("profiles").select("nickname").eq("id", S.me).maybeSingle().then(function(r){
    S.profile = r.data || {nickname: (session.user.user_metadata && session.user.user_metadata.nickname) || ""};
    S.msg = null; go("home");
    loadQuizzes();
  });
}

sb.auth.onAuthStateChange(function(event, session){
  /* volání Supabase uvnitř callbacku se odkládá, aby se nezaseklo přihlašování */
  setTimeout(function(){ onSession(session); }, 0);
});
})();
