(function(){
"use strict";

/* Veřejné údaje projektu Supabase. Publishable klíč smí být v kódu webu,
   přístup k datům hlídají pravidla RLS v supabase-setup.sql. */
var SUPABASE_URL = "https://aeorpvnzfryqpghsoofu.supabase.co";
var SUPABASE_KEY = "sb_publishable_OHuJ1ndmUhl3aoFx3P1j-g_TZeJ45KD";

var app = document.getElementById("app");
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* view: loading | auth | home | people | profile | detail | admin | lock | buy | play | edit */
var S = { view:"loading", authTab:"login", session:null, me:null, profile:null,
          quizzes:[], listError:null, msg:null, people:null, peopleQ:"", prof:null, owned:{}, following:{}, buyFor:null, det:null, adm:null, openReports:0, homeTab:"all", subject:"", sort:"new", play:null, edit:null, lockFor:null, filter:"", busy:false };

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
function msgEl(where){ return S.msg && (S.msg.where || null) === (where || null) ? el("p",{class:"msg "+S.msg.kind, text:S.msg.text, role:"status"}) : null; }
function render(){
  var a = document.activeElement, id = a && a.id && a.tagName === "INPUT" ? a.id : null, sel = id ? [a.selectionStart, a.selectionEnd] : null;
  app.replaceChildren.apply(app, view().filter(Boolean));
  renderBar();
  if (id){ var n = document.getElementById(id); if (n){ n.focus(); try { n.setSelectionRange(sel[0], sel[1]); } catch(e) {} } }
}
function go(v, keepMsg){ S.view = v; if (!keepMsg) S.msg = null; render(); window.scrollTo(0,0); }
/* Adresy: #kvizy (seznam), #lide (lidé), #u/<id> (profil), #q/<id> (detail kvízu), #admin (správa). */
function nav(h, keepMsg){ S.keepMsg = !!keepMsg; if (location.hash === h) route(); else location.hash = h; }
function route(){
  if (!S.me) return;
  var h = location.hash, keep = S.keepMsg; S.keepMsg = false;
  var m = /^#u\/([0-9a-f-]{36})$/i.exec(h);
  if (m){ openProfile(m[1]); go("profile", keep); return; }
  var mq = /^#q\/([0-9a-f-]{36})$/i.exec(h);
  if (mq){ openDetail(mq[1]); go("detail", keep); return; }
  if (h === "#admin"){ if (isAdmin()) openAdmin(); go("admin", keep); return; }
  if (h === "#lide"){ go("people", keep); loadPeople(); if (!S.quizzes.length) loadQuizzes(); return; }
  go("home", keep); loadQuizzes();
}
window.addEventListener("hashchange", route);
function focusLater(id){ setTimeout(function(){ var x=document.getElementById(id); if (x) x.focus(); },0); }
function plural(n, one, few, many){ return n===1 ? one : (n>=2 && n<=4) ? few : many; }
function err(kind, text, where){ S.msg = {kind:kind, text:text, where:where || null}; render(); }
function dbErrText(e){
  var m = (e && (e.message || e.error_description)) || "";
  if (/JWT|expired|not authenticated/i.test(m)) return "Přihlášení vypršelo. Odhlas se a přihlas znovu.";
  if (/row-level security|permission denied/i.test(m)) return "Na tohle nemáš oprávnění.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Nepovedlo se spojit s databází. Zkontroluj internet a zkus to znovu.";
  if (/NEDOSTATEK_KREDITU/.test(m)) return "Nemáš dost kreditů. Kredity ti přidá správce.";
  if (/column .* does not exist|Could not find the .* (column|table|function)|relation .* does not exist/i.test(m)) return "Databáze ještě nemá nejnovější nastavení. Správce musí znovu spustit supabase-setup.sql.";
  if (/^[A-ZÁ-Ž].*\.$/.test(m) && /[ěščřžýáíéůú]/i.test(m)) return m;
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
    case "people": return peopleView();
    case "profile": return profileView();
    case "detail": return detailView();
    case "admin": return adminView();
    case "lock": return [lockView()];
    case "buy": return buyView();
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

  var form = el("form",{class:"panel auth",onsubmit:function(e){ e.preventDefault(); reg ? doRegister(email.value, nick.value, pw.value) : doLogin(email.value, pw.value); }},[
    el("div",{class:"authbrand"},[el("span",{class:"brandmark","aria-hidden":"true",text:"K"}), el("strong",{text:"Kvízy"})]),
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


/* ---------- společné ---------- */
var QUIZ_COLS = "id,title,question_count,locked,price,subject,tags,rating_avg,rating_count,play_count,score_sum,total_sum,updated_at,author_id,profiles!quizzes_author_id_fkey(nickname,avatar_v)";
var SUBJECTS = ["Angličtina","Biologie","Botanika","Chemie","Ekonomie","Fyzika","Informatika","Matematika","Statistika","Zoologie"];
var LETTERS = "ABCDEF";
var MIN_A = 2, MAX_A = 6;

function isAdmin(){ return !!(S.profile && S.profile.is_admin); }
function canOpen(q){ return !q.price || q.author_id === S.me || !!S.owned[q.id] || isAdmin(); }
function kr(n){ return n+" "+plural(n,"kredit","kredity","kreditů"); }
function fmtDate(d){ try { return new Date(d).toLocaleDateString("cs-CZ",{day:"numeric",month:"numeric",year:"numeric"}); } catch(e) { return ""; } }
function pct(a, b){ return b ? Math.round(a / b * 100) : 0; }
function authorOf(q){ return (q.profiles && q.profiles.nickname) || "Neznámý"; }
function profileLink(id, name, cls){ return el("a",{href:"#u/"+id, class:cls || "plink", text:name || "Neznámý"}); }

function avatarUrl(id, v){ return SUPABASE_URL + "/storage/v1/object/public/avatars/" + id + "/avatar.jpg?v=" + v; }
function avatarEl(id, p, size){
  var name = (p && p.nickname) || "?";
  var fallback = el("span",{class:"avatar"+(size ? " "+size : ""),"aria-hidden":"true",text:name.charAt(0).toUpperCase()});
  if (!p || !p.avatar_v) return fallback;
  var img = el("img",{class:"avatar"+(size ? " "+size : ""),src:avatarUrl(id, p.avatar_v),alt:"",loading:"lazy",width:"64",height:"64"});
  img.addEventListener("error", function(){ if (img.parentNode) img.replaceWith(fallback); });
  return img;
}
function starsText(avg){
  var n = Math.round(Number(avg) || 0), s = "";
  for (var i = 1; i <= 5; i++) s += i <= n ? "★" : "☆";
  return s;
}
function ratingLabel(q){
  return q.rating_count ? starsText(q.rating_avg)+" "+Number(q.rating_avg).toFixed(1).replace(".", ",")+" ("+q.rating_count+")" : "Bez hodnocení";
}

/* ---------- načítání ---------- */
function loadQuizzes(){
  return sb.from("quizzes").select(QUIZ_COLS).order("updated_at",{ascending:false}).limit(500).then(function(r){
    if (r.error){ S.listError = dbErrText(r.error); S.quizzes = []; }
    else { S.listError = null; S.quizzes = r.data || []; }
    if (S.view === "home" || S.view === "people") render();
  });
}
function refreshMe(){
  return sb.from("profiles").select("nickname,credits,is_admin,avatar_v,bio").eq("id", S.me).maybeSingle().then(function(r){
    if (r.data) S.profile = r.data;
    if (isAdmin()) sb.from("reports").select("id",{count:"exact",head:true}).eq("status","open").then(function(c){ S.openReports = c.count || 0; renderBar(); });
    renderBar();
  });
}
function loadOwned(){
  return sb.from("purchases").select("quiz_id").eq("buyer_id", S.me).then(function(r){
    var o = {}; (r.data || []).forEach(function(p){ o[p.quiz_id] = true; }); S.owned = o;
  });
}
function loadFollowing(){
  return sb.from("follows").select("followee_id").eq("follower_id", S.me).then(function(r){
    var o = {}; (r.data || []).forEach(function(f){ o[f.followee_id] = true; }); S.following = o;
  });
}

/* ---------- horní lišta ---------- */
var bar = document.getElementById("bar");
function renderBar(){
  if (!bar) return;
  if (!S.me || S.view === "auth" || S.view === "loading"){ bar.hidden = true; return; }
  bar.hidden = false;
  var cur = S.view === "people" ? "people" : S.view === "admin" ? "admin"
          : (S.view === "profile" && S.prof && S.prof.id === S.me) ? "me" : (S.view === "profile" ? "people" : "home");
  function link(href, text, key, extra){ return el("a",{href:href, class:"navlink", "aria-current": cur === key ? "page" : null},[text, extra || null]); }
  bar.replaceChildren(el("div",{class:"barin"},[
    el("a",{href:"#kvizy",class:"brand"},[el("span",{class:"brandmark","aria-hidden":"true",text:"K"}), el("span",{},[el("strong",{text:"Kvízy"}), el("small",{text:"studijní materiály"})])]),
    el("nav",{class:"navlinks","aria-label":"Hlavní menu"},[
      link("#kvizy","Kvízy","home"),
      link("#lide","Lidé","people"),
      isAdmin() ? link("#admin","Správa","admin", S.openReports ? el("span",{class:"badge","aria-label":S.openReports+" nevyřešených nahlášení",text:String(S.openReports)}) : null) : null,
      link("#u/"+S.me,"Můj profil","me"),
      el("a",{href:"#u/"+S.me, class:"credits", title:"Tvoje kredity", text:kr((S.profile && S.profile.credits) || 0)}),
      el("button",{class:"navlink navbtn",text:"Odhlásit",onclick:logout})
    ])
  ]));
}

/* ---------- seznam kvízů ---------- */
function quizCard(q, showAuthor){
  var mine = q.author_id === S.me, n = q.question_count || 0, owned = !!S.owned[q.id];
  var pills = [
    q.subject ? el("span",{class:"pill subject",text:q.subject}) : null,
    q.price ? el("span",{class:"pill price",text:kr(q.price)}) : el("span",{class:"pill free",text:"Zdarma"}),
    mine ? el("span",{class:"pill mine",text:"Tvůj"}) : null,
    owned && !mine ? el("span",{class:"pill mine",text:"Koupeno"}) : null,
    q.locked ? el("span",{class:"pill",text:"Na heslo"}) : null
  ];
  var card = el("a",{class:"card",href:"#q/"+q.id},[
    el("span",{class:"txt"},[
      el("span",{class:"row",style:"gap:6px"}, pills),
      el("strong",{text:q.title||"Bez názvu"}),
      el("span",{class:"muted small"},[
        el("span",{class: q.rating_count ? "stars" : "",text:ratingLabel(q)}),
        " · "+n+" "+plural(n,"otázka","otázky","otázek")+" · hráno "+(q.play_count||0)+"×"
      ]),
      (q.tags && q.tags.length) ? el("span",{class:"tags"}, q.tags.map(function(t){ return el("span",{class:"tag",text:"#"+t}); })) : null
    ]),
    el("span",{class:"go",text: canOpen(q) ? "Otevřít" : "Koupit"})
  ]);
  var meta = el("div",{class:"cardmeta"},[
    showAuthor ? el("span",{class:"by small muted"},[avatarEl(q.author_id, q.profiles, "xs"), profileLink(q.author_id, authorOf(q))]) : null,
    mine ? el("button",{class:"btn link small",text:"Upravit",onclick:function(){ openQuiz(q.id, "edit"); }}) : null,
    (mine || isAdmin()) ? el("button",{class:"btn link small danger-link",text: mine ? "Smazat" : "Smazat (správce)",onclick:function(e){ confirmDelete(e.currentTarget, q.id); }}) : null
  ]);
  return el("div",{class:"cardwrap"},[card, (showAuthor || mine || isAdmin()) ? meta : null]);
}

function homeView(){
  var list = S.quizzes, f = S.filter.trim().toLowerCase().replace(/^#/, "");
  var subjects = {}; list.forEach(function(q){ if (q.subject) subjects[q.subject] = true; });
  var shown = list.filter(function(q){
    if (S.homeTab === "following" && !S.following[q.author_id]) return false;
    if (S.subject && q.subject !== S.subject) return false;
    if (!f) return true;
    return (q.title||"").toLowerCase().indexOf(f) >= 0 || authorOf(q).toLowerCase().indexOf(f) >= 0
      || (q.subject||"").toLowerCase().indexOf(f) >= 0 || (q.tags||[]).some(function(t){ return t.indexOf(f) >= 0; });
  });
  var sorters = {
    new: function(a,b){ return new Date(b.updated_at) - new Date(a.updated_at); },
    rating: function(a,b){ return (Number(b.rating_avg)||0) - (Number(a.rating_avg)||0) || b.rating_count - a.rating_count; },
    plays: function(a,b){ return (b.play_count||0) - (a.play_count||0); },
    cheap: function(a,b){ return (a.price||0) - (b.price||0); }
  };
  shown = shown.slice().sort(sorters[S.sort] || sorters.new);

  var search = el("input",{type:"search",id:"search",placeholder:"Hledat kvíz, autora nebo #štítek","aria-label":"Hledat kvízy",oninput:function(e){ S.filter = e.target.value; render(); }});
  search.value = S.filter;
  var subjSel = el("select",{id:"f-subject","aria-label":"Předmět",onchange:function(e){ S.subject = e.target.value; render(); }},
    [el("option",{value:"",text:"Všechny předměty"})].concat(Object.keys(subjects).sort().map(function(s){ return el("option",{value:s,text:s}); })));
  subjSel.value = S.subject;
  var sortSel = el("select",{id:"f-sort","aria-label":"Řazení",onchange:function(e){ S.sort = e.target.value; render(); }},[
    el("option",{value:"new",text:"Nejnovější"}), el("option",{value:"rating",text:"Nejlépe hodnocené"}),
    el("option",{value:"plays",text:"Nejhranější"}), el("option",{value:"cheap",text:"Nejlevnější"})
  ]);
  sortSel.value = S.sort;
  var nFollow = Object.keys(S.following).length;
  var tabs = el("div",{class:"tabs",role:"group","aria-label":"Které kvízy"},[
    el("button",{type:"button",class:"tab","aria-pressed":String(S.homeTab !== "following"),text:"Všechny",onclick:function(){ S.homeTab = "all"; render(); }}),
    el("button",{type:"button",class:"tab","aria-pressed":String(S.homeTab === "following"),text:"Od sledovaných ("+nFollow+")",onclick:function(){ S.homeTab = "following"; render(); }})
  ]);

  var empty = S.homeTab === "following" && !nFollow ? "Zatím nikoho nesleduješ. Otevři profil autora v sekci Lidé a dej Sledovat."
            : list.length ? "Nic takového tu není." : "Zatím tu nikdo žádný kvíz nevytvořil. Buď první!";
  var cards = S.listError ? el("p",{class:"msg err",text:S.listError}) :
    shown.length ? el("div",{class:"cards"}, shown.map(function(q){ return quizCard(q, true); }))
    : el("p",{class:"muted",text:empty});

  return [
    el("div",{class:"top"},[
      el("div",{},[el("span",{class:"label",text:"Ahoj, "+(S.profile ? S.profile.nickname : "")}), el("h1",{text:"Všechny kvízy"})]),
      el("button",{class:"btn",text:"Nový kvíz",onclick:function(){ openEditor(null, [], ""); }})
    ]),
    msgEl(),
    tabs,
    el("div",{class:"filters"},[search, subjSel, sortSel]),
    cards
  ];
}

function confirmDelete(btn, id){
  if (btn.dataset.armed){
    btn.disabled = true;
    sb.from("quizzes").delete().eq("id", id).then(function(r){
      if (r.error) return err("err", dbErrText(r.error));
      S.quizzes = S.quizzes.filter(function(q){ return q.id !== id; });
      if (S.prof && S.prof.quizzes) S.prof.quizzes = S.prof.quizzes.filter(function(q){ return q.id !== id; });
      if (S.adm && S.adm.reports) S.adm.reports = S.adm.reports.filter(function(x){ return x.quiz_id !== id; });
      if (S.view === "detail") { nav("#kvizy"); return; }
      err("ok","Kvíz smazán.");
    });
  } else {
    var label = btn.textContent;
    btn.dataset.armed = "1"; btn.textContent = "Opravdu smazat?";
    setTimeout(function(){ if (btn.isConnected){ delete btn.dataset.armed; btn.textContent = label; } }, 4000);
  }
}

/* ---------- detail kvízu ---------- */
var detailSeq = 0;
function openDetail(id){
  var seq = ++detailSeq;
  S.det = {id:id, loading:true};
  Promise.all([
    sb.from("quizzes").select(QUIZ_COLS).eq("id", id).maybeSingle(),
    sb.from("ratings").select("user_id,stars,comment,updated_at,profiles!ratings_user_id_fkey(nickname,avatar_v)").eq("quiz_id", id).order("updated_at",{ascending:false}).limit(200),
    sb.from("plays").select("score,total,created_at").eq("quiz_id", id).eq("user_id", S.me).order("created_at",{ascending:false}).limit(200)
  ]).then(function(r){
    if (seq !== detailSeq) return;
    var e = r[0].error || r[1].error || r[2].error;
    if (e){ S.det = {id:id, error:dbErrText(e)}; }
    else {
      var ratings = r[1].data || [], mine = ratings.find(function(x){ return x.user_id === S.me; });
      S.det = {id:id, q:r[0].data, ratings:ratings, plays:r[2].data || [],
               draft:{stars: mine ? mine.stars : 0, comment: mine ? (mine.comment || "") : ""}, hasMine:!!mine, reporting:false};
    }
    if (S.view === "detail") render();
  });
}

function detailView(){
  var D = S.det || {};
  if (D.loading) return [el("div",{class:"panel"},[el("h2",{text:"Načítám kvíz…"})])];
  if (D.error) return [el("p",{class:"msg err",text:D.error})];
  if (!D.q) return [el("div",{class:"panel"},[el("h2",{text:"Tenhle kvíz neexistuje"}), el("p",{},[el("a",{href:"#kvizy",class:"plink",text:"Zpět na kvízy"})])])];
  var q = D.q, mine = q.author_id === S.me, open = canOpen(q), n = q.question_count || 0;
  var best = D.plays.reduce(function(b, p){ return !b || p.score / p.total > b.score / b.total ? p : b; }, null);

  var actions = el("div",{class:"row"},[
    open ? el("button",{class:"btn",text:"Hrát",onclick:function(){ openQuiz(q.id, "play"); }})
         : el("button",{class:"btn",text:"Koupit za "+kr(q.price),onclick:function(){ S.buyFor = q; go("buy"); }}),
    mine ? el("button",{class:"btn ghost",text:"Upravit",onclick:function(){ openQuiz(q.id, "edit"); }}) : null,
    (mine || isAdmin()) ? el("button",{class:"btn ghost danger-btn",text: mine ? "Smazat" : "Smazat (správce)",onclick:function(e){ confirmDelete(e.currentTarget, q.id); }}) : null
  ]);

  var head = el("section",{class:"panel detail"},[
    el("span",{class:"row",style:"gap:6px"},[
      q.subject ? el("span",{class:"pill subject",text:q.subject}) : null,
      q.price ? el("span",{class:"pill price",text:kr(q.price)}) : el("span",{class:"pill free",text:"Zdarma"}),
      S.owned[q.id] && !mine ? el("span",{class:"pill mine",text:"Koupeno"}) : null,
      q.locked ? el("span",{class:"pill",text:"Na heslo"}) : null
    ]),
    el("h1",{text:q.title}),
    el("span",{class:"by muted"},[avatarEl(q.author_id, q.profiles, "sm"), "Autor: ", profileLink(q.author_id, authorOf(q)), " · upraveno "+fmtDate(q.updated_at)]),
    (q.tags && q.tags.length) ? el("span",{class:"tags"}, q.tags.map(function(t){
      return el("button",{class:"tag",type:"button",text:"#"+t,title:"Najít kvízy se štítkem "+t,onclick:function(){ S.filter = "#"+t; nav("#kvizy"); }});
    })) : null,
    el("dl",{class:"stats four"},[
      el("div",{},[el("dt",{text:"Otázky"}), el("dd",{text:String(n)})]),
      el("div",{},[el("dt",{text:"Hodnocení"}), el("dd",{text: q.rating_count ? Number(q.rating_avg).toFixed(1).replace(".", ",") : "–"}), el("span",{class:"muted small",text: q.rating_count ? q.rating_count+" "+plural(q.rating_count,"hodnocení","hodnocení","hodnocení") : "zatím nikdo"})]),
      el("div",{},[el("dt",{text:"Hráno"}), el("dd",{text:(q.play_count||0)+"×"})]),
      el("div",{},[el("dt",{text:"Úspěšnost"}), el("dd",{text: q.total_sum ? pct(q.score_sum, q.total_sum)+" %" : "–"}), el("span",{class:"muted small",text:"průměr všech"})])
    ]),
    best ? el("p",{class:"yourbest"},["Tvoje nejlepší skóre: ", el("strong",{text:best.score+" / "+best.total+" ("+pct(best.score,best.total)+" %)"}), " · hráls "+D.plays.length+"×"]) : null,
    msgEl(),
    actions
  ]);

  return [
    el("div",{},[el("a",{href:"#kvizy",class:"plink small",text:"← Všechny kvízy"})]),
    head,
    ratingSection(D, q, mine, open),
    mine ? null : reportSection(D, q)
  ];
}

function ratingSection(D, q, mine, open){
  var form = null;
  if (!mine && open){
    var starBtns = [1,2,3,4,5].map(function(i){
      return el("button",{type:"button",class:"starbtn"+(i <= D.draft.stars ? " on" : ""),"aria-label":i+" "+plural(i,"hvězdička","hvězdičky","hvězdiček"),"aria-pressed":String(D.draft.stars === i),text:i <= D.draft.stars ? "★" : "☆",
        onclick:function(){ D.draft.stars = i; render(); }});
    });
    var ta = el("textarea",{id:"rate-comment",maxlength:"500",placeholder:"Co se ti líbilo nebo co bys zlepšil? (nepovinné)",style:"min-height:90px",oninput:function(e){ D.draft.comment = e.target.value; }});
    ta.value = D.draft.comment;
    var save = el("button",{class:"btn",type:"submit",text: D.hasMine ? "Uložit změnu" : "Odeslat hodnocení"});
    form = el("form",{class:"rateform",onsubmit:function(e){
      e.preventDefault();
      if (!D.draft.stars) return err("err","Vyber počet hvězdiček.","rate");
      save.disabled = true;
      sb.from("ratings").upsert({quiz_id:q.id, user_id:S.me, stars:D.draft.stars, comment:D.draft.comment.trim() || null, updated_at:new Date().toISOString()},{onConflict:"quiz_id,user_id"}).then(function(r){
        if (r.error){ save.disabled = false; return err("err", dbErrText(r.error), "rate"); }
        S.msg = {kind:"ok", text:"Díky za hodnocení!", where:"rate"};
        openDetail(q.id);
      });
    }},[
      el("span",{class:"label",text: D.hasMine ? "Tvoje hodnocení" : "Ohodnoť kvíz"}),
      el("div",{class:"starrow",role:"group","aria-label":"Počet hvězdiček"}, starBtns),
      ta,
      msgEl("rate"),
      el("div",{class:"row"},[save,
        D.hasMine ? el("button",{class:"btn link small danger-link",type:"button",text:"Smazat hodnocení",onclick:function(){
          sb.from("ratings").delete().eq("quiz_id", q.id).eq("user_id", S.me).then(function(r){
            if (r.error) return err("err", dbErrText(r.error), "rate");
            S.msg = {kind:"ok", text:"Hodnocení smazáno.", where:"rate"}; openDetail(q.id);
          });
        }}) : null])
    ]);
  }
  var note = mine ? el("p",{class:"muted small",text:"Svůj kvíz hodnotit nemůžeš."})
           : !open ? el("p",{class:"muted small",text:"Hodnotit můžeš, až kvíz koupíš."}) : null;
  var list = D.ratings.length ? el("ul",{class:"reviews"}, D.ratings.map(function(x){
    return el("li",{},[
      avatarEl(x.user_id, x.profiles, "sm"),
      el("div",{class:"txt"},[
        el("div",{class:"row",style:"gap:8px"},[profileLink(x.user_id, (x.profiles && x.profiles.nickname)), el("span",{class:"stars",text:starsText(x.stars)}), el("span",{class:"muted small",text:fmtDate(x.updated_at)})]),
        x.comment ? el("p",{text:x.comment}) : null,
        isAdmin() && x.user_id !== S.me ? el("button",{class:"btn link small danger-link",text:"Smazat (správce)",onclick:function(){
          sb.from("ratings").delete().eq("quiz_id", q.id).eq("user_id", x.user_id).then(function(r){
            if (r.error) return err("err", dbErrText(r.error), "rate");
            S.msg = {kind:"ok", text:"Hodnocení smazáno.", where:"rate"}; openDetail(q.id);
          });
        }}) : null
      ])
    ]);
  })) : el("p",{class:"muted",text:"Zatím tu nejsou žádná hodnocení."});
  return el("section",{class:"panel"},[el("h2",{text:"Hodnocení"}), form, note, list]);
}

function reportSection(D, q){
  if (!D.reporting) return el("div",{},[el("button",{class:"btn link small danger-link",text:"Nahlásit kvíz",onclick:function(){ D.reporting = true; render(); focusLater("report-reason"); }}), msgEl("report")]);
  var ta = el("textarea",{id:"report-reason",maxlength:"500",style:"min-height:90px",placeholder:"Napiš, co je špatně: chybné odpovědi, nevhodný obsah, kopie cizího kvízu…"});
  var send = el("button",{class:"btn",type:"submit",text:"Odeslat nahlášení"});
  return el("form",{class:"panel report",onsubmit:function(e){
    e.preventDefault();
    var t = ta.value.trim();
    if (t.length < 3) return err("err","Napiš aspoň pár slov, co je špatně.","report");
    send.disabled = true;
    sb.from("reports").insert({quiz_id:q.id, reason:t}).then(function(r){
      if (r.error){
        send.disabled = false;
        return err("err", /duplicate|unique/i.test(r.error.message||"") ? "Tenhle kvíz už jsi nahlásil. Správce se na to podívá." : dbErrText(r.error), "report");
      }
      D.reporting = false;
      err("ok","Nahlášeno. Správce se na to podívá.","report");
    });
  }},[
    el("h2",{text:"Nahlásit kvíz"}),
    el("label",{class:"label",for:"report-reason",text:"Důvod"}), ta,
    msgEl("report"),
    el("div",{class:"row"},[send, el("button",{class:"btn ghost",type:"button",text:"Zrušit",onclick:function(){ D.reporting = false; S.msg = null; render(); }})])
  ]);
}

/* ---------- nákup ---------- */
function buyView(){
  var q = S.buyFor, have = (S.profile && S.profile.credits) || 0, missing = q.price - have;
  var btn = el("button",{class:"btn",text:"Koupit za "+kr(q.price),disabled: missing > 0,onclick:function(){
    btn.disabled = true; btn.textContent = "Kupuju…";
    sb.rpc("buy_quiz",{p_quiz:q.id}).then(function(r){
      if (r.error){ btn.disabled = false; btn.textContent = "Koupit za "+kr(q.price); return err("err", dbErrText(r.error)); }
      S.profile.credits = r.data; S.owned[q.id] = true; renderBar();
      openQuiz(q.id, "play");
    });
  }});
  return [
    el("div",{class:"top"},[el("h1",{text:"Koupit materiál"}), el("a",{class:"plink",href:"#q/"+q.id,text:"Zpět na kvíz"})]),
    el("div",{class:"panel buy"},[
      el("span",{class:"label",text:"Placený kvíz"}),
      el("h2",{text:q.title}),
      el("p",{class:"muted"},[ (q.question_count||0)+" "+plural(q.question_count||0,"otázka","otázky","otázek")+" · autor ", profileLink(q.author_id, authorOf(q)) ]),
      el("dl",{class:"stats two"},[
        el("div",{},[el("dt",{text:"Cena"}), el("dd",{text:kr(q.price)})]),
        el("div",{},[el("dt",{text:"Máš"}), el("dd",{text:kr(have)})])
      ]),
      missing > 0 ? el("p",{class:"msg err",text:"Chybí ti "+kr(missing)+". Kredity ti přidá správce."})
                  : el("p",{class:"muted small",text:"Po nákupu ti zůstane "+kr(have - q.price)+". Kvíz pak můžeš hrát kdykoli znovu. Kredity dostane autor."}),
      msgEl(),
      el("div",{class:"row"},[btn])
    ])
  ];
}

/* ---------- lidé ---------- */
var peopleTimer = null, peopleSeq = 0;
function loadPeople(){
  var q = S.peopleQ.trim(), seq = ++peopleSeq;
  var req = sb.from("profiles").select("id,nickname,created_at,avatar_v,bio").order("nickname").limit(50);
  if (q) req = req.ilike("nickname", "%" + q.replace(/[\\%_]/g, "\\$&") + "%");
  req.then(function(r){
    if (seq !== peopleSeq) return;
    S.people = r.error ? {error:dbErrText(r.error)} : {rows:r.data || []};
    if (S.view === "people") render();
  });
}

function peopleView(){
  var search = el("input",{type:"search",id:"people-search",placeholder:"Napiš přezdívku","aria-label":"Hledat lidi podle přezdívky",oninput:function(e){
    S.peopleQ = e.target.value; clearTimeout(peopleTimer); peopleTimer = setTimeout(loadPeople, 250);
  }});
  search.value = S.peopleQ;
  if (!S.peopleQ) focusLater("people-search");
  var counts = {};
  S.quizzes.forEach(function(q){ counts[q.author_id] = (counts[q.author_id]||0) + 1; });
  var body;
  if (!S.people) body = el("p",{class:"muted",text:"Načítám…"});
  else if (S.people.error) body = el("p",{class:"msg err",text:S.people.error});
  else if (!S.people.rows.length) body = el("p",{class:"muted",text: S.peopleQ ? "Nikoho s přezdívkou „"+S.peopleQ.trim()+"“ jsem nenašel." : "Zatím tu nikdo není."});
  else body = el("div",{class:"people"}, S.people.rows.map(function(p){
    var n = counts[p.id] || 0;
    return el("a",{href:"#u/"+p.id, class:"person"},[
      avatarEl(p.id, p),
      el("span",{class:"txt"},[
        el("strong",{text:p.nickname + (p.id === S.me ? " (ty)" : "")}),
        el("span",{class:"muted small",text:n+" "+plural(n,"kvíz","kvízy","kvízů")+" · od "+fmtDate(p.created_at)+(S.following[p.id] ? " · sleduješ" : "")}),
        p.bio ? el("span",{class:"small bio1",text:p.bio}) : null
      ]),
      el("span",{class:"go",text:"Profil"})
    ]);
  }));
  return [
    el("div",{class:"top"},[el("div",{},[el("span",{class:"label",text:"Lidé"}), el("h1",{text:"Najdi spolužáka"})])]),
    search,
    body
  ];
}

/* ---------- profil ---------- */
function openProfile(id){
  var seq = ++peopleSeq, priv = id === S.me || isAdmin();
  S.prof = {id:id, loading:true};
  var none = Promise.resolve({data:[]});
  Promise.all([
    sb.from("profiles").select("id,nickname,created_at,credits,is_admin,avatar_v,bio").eq("id", id).maybeSingle(),
    sb.from("quizzes").select(QUIZ_COLS).eq("author_id", id).order("updated_at",{ascending:false}),
    priv ? sb.from("purchases").select("created_at,quizzes("+QUIZ_COLS+")").eq("buyer_id", id).order("created_at",{ascending:false}) : none,
    priv ? sb.from("credit_log").select("amount,reason,created_at").eq("user_id", id).order("created_at",{ascending:false}).limit(20) : none,
    sb.from("follows").select("follower_id",{count:"exact",head:true}).eq("followee_id", id),
    sb.from("follows").select("followee_id",{count:"exact",head:true}).eq("follower_id", id),
    priv ? sb.from("plays").select("score,total").eq("user_id", id).limit(1000) : none
  ]).then(function(r){
    if (seq !== peopleSeq) return;
    var e = r.map(function(x){ return x.error; }).filter(Boolean)[0];
    if (e){ S.prof = {id:id, error:dbErrText(e)}; }
    else {
      var plays = r[6].data || [];
      S.prof = {id:id, p:r[0].data, quizzes:r[1].data || [],
        bought:(r[2].data || []).map(function(x){ return x.quizzes; }).filter(Boolean), log:r[3].data || [],
        followers:r[4].count || 0, followingN:r[5].count || 0, priv:priv,
        played:plays.length, score:plays.reduce(function(a,p){ return a + p.score; }, 0), total:plays.reduce(function(a,p){ return a + p.total; }, 0)};
      if (id === S.me && r[0].data){ S.profile = Object.assign({}, S.profile, r[0].data); renderBar(); }
    }
    if (S.view === "profile") render();
  });
}

function toggleFollow(P, btn){
  btn.disabled = true;
  var on = !!S.following[P.id];
  var req = on ? sb.from("follows").delete().eq("follower_id", S.me).eq("followee_id", P.id)
               : sb.from("follows").insert({followee_id:P.id});
  req.then(function(r){
    if (r.error){ btn.disabled = false; return err("err", dbErrText(r.error)); }
    if (on){ delete S.following[P.id]; P.followers = Math.max(0, P.followers - 1); }
    else { S.following[P.id] = true; P.followers++; }
    S.msg = null; render();
  });
}

function resizeAvatar(file){
  return createImageBitmap(file).then(function(img){
    var size = 256, c = document.createElement("canvas"), s = Math.min(img.width, img.height);
    c.width = size; c.height = size;
    c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    return new Promise(function(res, rej){ c.toBlob(function(b){ b ? res(b) : rej(new Error("toBlob")); }, "image/jpeg", 0.86); });
  });
}

function avatarControls(P){
  var file = el("input",{type:"file",id:"avatar-file",accept:"image/*"});
  file.hidden = true;
  file.addEventListener("change", function(){
    var f = file.files && file.files[0]; if (!f) return;
    file.value = "";
    err("ok","Nahrávám profilovku…","avatar");
    resizeAvatar(f).then(function(blob){
      return sb.storage.from("avatars").upload(S.me + "/avatar.jpg", blob, {upsert:true, contentType:"image/jpeg", cacheControl:"3600"});
    }).then(function(r){
      if (r.error) throw r.error;
      var v = Date.now();
      return sb.from("profiles").update({avatar_v:v}).eq("id", S.me).then(function(u){
        if (u.error) throw u.error;
        P.p.avatar_v = v; S.profile.avatar_v = v;
        err("ok","Profilovka je nastavená.","avatar");
      });
    }).catch(function(e){
      err("err", /Bucket not found/i.test((e && e.message) || "") ? "Úložiště profilovek ještě není nastavené. Spusť znovu supabase-setup.sql." :
                 (e && e.message === "toBlob") || e instanceof DOMException ? "Tenhle obrázek se nepovedlo načíst. Zkus JPG nebo PNG." : dbErrText(e), "avatar");
    });
  });
  return el("div",{class:"row",style:"gap:12px"},[
    el("label",{class:"btn link small",for:"avatar-file",tabindex:"0",role:"button",text: P.p.avatar_v ? "Změnit profilovku" : "Nahrát profilovku",onkeydown:function(e){ if (e.key==="Enter"||e.key===" "){ e.preventDefault(); file.click(); } }}),
    file,
    P.p.avatar_v ? el("button",{class:"btn link small danger-link",type:"button",text:"Odebrat",onclick:function(){
      sb.storage.from("avatars").remove([S.me + "/avatar.jpg"]).then(function(){
        return sb.from("profiles").update({avatar_v:null}).eq("id", S.me);
      }).then(function(u){
        if (u && u.error) return err("err", dbErrText(u.error), "avatar");
        P.p.avatar_v = null; S.profile.avatar_v = null; err("ok","Profilovka odebrána.","avatar");
      });
    }}) : null
  ]);
}

function bioBlock(P, me){
  if (P.editBio){
    var ta = el("textarea",{id:"bio",maxlength:"300",style:"min-height:80px",placeholder:"Např. 2. ročník, obor Zahradnictví. Dělám kvízy z botaniky."});
    ta.value = P.p.bio || "";
    var save = el("button",{class:"btn sm",type:"submit",text:"Uložit"});
    return el("form",{class:"field",onsubmit:function(e){
      e.preventDefault(); save.disabled = true;
      var t = ta.value.trim() || null;
      sb.from("profiles").update({bio:t}).eq("id", S.me).then(function(r){
        if (r.error){ save.disabled = false; return err("err", dbErrText(r.error)); }
        P.p.bio = t; S.profile.bio = t; P.editBio = false; S.msg = null; render();
      });
    }},[el("label",{class:"label",for:"bio",text:"O mně"}), ta,
        el("div",{class:"row"},[save, el("button",{class:"btn ghost sm",type:"button",text:"Zrušit",onclick:function(){ P.editBio = false; render(); }})])]);
  }
  return el("div",{class:"bio"},[
    P.p.bio ? el("p",{text:P.p.bio}) : (me ? el("p",{class:"muted",text:"Napiš o sobě pár slov, ať ostatní ví, co studuješ."}) : null),
    me ? el("button",{class:"btn link small",text: P.p.bio ? "Upravit popis" : "Přidat popis",onclick:function(){ P.editBio = true; render(); focusLater("bio"); }}) : null
  ]);
}

function adminBox(P){
  var amt = el("input",{type:"number",id:"adm-amount",step:"1",placeholder:"Např. 50",inputmode:"numeric"});
  var note = el("input",{type:"text",id:"adm-note",maxlength:"80",placeholder:"Důvod (nepovinné), např. Odměna za aktivitu"});
  function send(sign, b){
    var n = Math.abs(parseInt(amt.value, 10));
    if (!n){ err("err","Zadej počet kreditů.", "admin"); return focusLater("adm-amount"); }
    b.disabled = true;
    sb.rpc("admin_add_credits",{p_user:P.id, p_amount:sign*n, p_note:note.value}).then(function(r){
      if (r.error){ b.disabled = false; return err("err", dbErrText(r.error), "admin"); }
      P.p.credits = r.data;
      if (P.id === S.me){ S.profile.credits = r.data; }
      P.log.unshift({amount:sign*n, reason:note.value.trim() || "Kredity od správce", created_at:new Date().toISOString()});
      err("ok", (sign > 0 ? "Přidáno " : "Odebráno ")+kr(n)+". "+P.p.nickname+" má teď "+kr(r.data)+".", "admin");
    });
  }
  var add = el("button",{class:"btn",type:"submit",text:"Přidat kredity"});
  var sub = el("button",{class:"btn ghost",type:"button",text:"Odebrat",onclick:function(e){ send(-1, e.currentTarget); }});
  return el("form",{class:"panel adminbox",onsubmit:function(e){ e.preventDefault(); send(1, add); }},[
    el("span",{class:"label",text:"Správce"}),
    el("h2",{text:"Kredity pro "+P.p.nickname}),
    el("div",{class:"grid2"},[
      el("div",{class:"field"},[el("label",{class:"label",for:"adm-amount",text:"Počet kreditů"}), amt]),
      el("div",{class:"field"},[el("label",{class:"label",for:"adm-note",text:"Důvod"}), note])
    ]),
    msgEl("admin"),
    el("div",{class:"row"},[add, sub])
  ]);
}

function renameForm(P){
  var inp = el("input",{type:"text",id:"rename",maxlength:"30",autocomplete:"nickname","aria-label":"Nová přezdívka"});
  inp.value = P.p.nickname;
  var save = el("button",{class:"btn sm",type:"submit",text:"Uložit"});
  return el("form",{class:"rename",onsubmit:function(e){
    e.preventDefault();
    var n = inp.value.trim();
    if (n === P.p.nickname){ P.renaming = false; return render(); }
    if (n.length < 2 || n.length > 30){ err("err","Přezdívka musí mít 2 až 30 znaků."); return focusLater("rename"); }
    save.disabled = true;
    sb.from("profiles").update({nickname:n}).eq("id", S.me).then(function(r){
      if (r.error){
        save.disabled = false;
        err("err", /duplicate|unique/i.test(r.error.message||"") ? "Tuhle přezdívku už někdo má. Vyber si jinou." : dbErrText(r.error));
        return focusLater("rename");
      }
      P.p.nickname = n; S.profile.nickname = n; P.renaming = false;
      S.quizzes.forEach(function(q){ if (q.author_id === S.me && q.profiles) q.profiles = Object.assign({}, q.profiles, {nickname:n}); });
      P.quizzes.forEach(function(q){ if (q.profiles) q.profiles = Object.assign({}, q.profiles, {nickname:n}); });
      S.people = null;
      err("ok","Přezdívka změněná na „"+n+"“.");
    });
  }},[
    inp,
    el("div",{class:"row"},[save, el("button",{class:"btn ghost sm",type:"button",text:"Zrušit",onclick:function(){ P.renaming = false; S.msg = null; render(); }})])
  ]);
}

function profileView(){
  var P = S.prof || {};
  if (P.loading) return [el("div",{class:"panel"},[el("h2",{text:"Načítám profil…"})])];
  if (P.error) return [el("p",{class:"msg err",text:P.error})];
  if (!P.p) return [el("div",{class:"panel"},[el("h2",{text:"Tenhle profil neexistuje"}), el("p",{},[el("a",{href:"#lide",class:"plink",text:"Zpět na lidi"})])])];
  var me = P.id === S.me, qs = P.quizzes;
  var stats = [
    el("div",{},[el("dt",{text:"Kvízy"}), el("dd",{text:String(qs.length)})]),
    el("div",{},[el("dt",{text:"Sledující"}), el("dd",{text:String(P.followers)})]),
    el("div",{},[el("dt",{text:"Sleduje"}), el("dd",{text:String(P.followingN)})]),
    P.priv ? el("div",{},[el("dt",{text:"Kredity"}), el("dd",{text:String(P.p.credits || 0)})]) : null,
    P.priv ? el("div",{},[el("dt",{text:"Odehráno"}), el("dd",{text:P.played+"×"})]) : null,
    P.priv ? el("div",{},[el("dt",{text:"Úspěšnost"}), el("dd",{text: P.total ? pct(P.score, P.total)+" %" : "–"})]) : null
  ];
  var followBtn = !me ? el("button",{class: S.following[P.id] ? "btn ghost" : "btn",text: S.following[P.id] ? "Sleduješ · Přestat" : "Sledovat",onclick:function(e){ toggleFollow(P, e.currentTarget); }}) : null;
  return [
    el("section",{class:"panel profile"},[
      el("div",{class:"profhead"},[
        avatarEl(P.id, P.p, "big"),
        el("div",{class:"txt"},[
          el("span",{class:"row",style:"gap:8px"},[el("span",{class:"label",text: me ? "Tvůj profil" : "Profil"}), P.p.is_admin ? el("span",{class:"pill admin",text:"Správce"}) : null]),
          P.renaming ? renameForm(P) : el("h1",{text:P.p.nickname}),
          el("span",{class:"muted small"},["Členem od "+fmtDate(P.p.created_at),
            me && !P.renaming ? el("button",{class:"btn link small",style:"margin-left:12px",text:"Změnit přezdívku",onclick:function(){ P.renaming = true; S.msg = null; render(); focusLater("rename"); }}) : null]),
          me ? avatarControls(P) : null,
          msgEl("avatar")
        ]),
        followBtn ? el("div",{class:"followwrap"},[followBtn]) : null
      ]),
      bioBlock(P, me),
      el("dl",{class:"stats"}, stats)
    ]),
    isAdmin() ? adminBox(P) : null,
    msgEl(),
    el("div",{class:"top"},[el("h2",{text: me ? "Moje materiály" : "Materiály"}), me ? el("button",{class:"btn",text:"Nový kvíz",onclick:function(){ openEditor(null, [], ""); }}) : null]),
    qs.length ? el("div",{class:"cards"}, qs.map(function(q){ return quizCard(q, false); }))
      : el("p",{class:"muted",text: me ? "Zatím jsi nic nevytvořil. Dej Nový kvíz." : P.p.nickname+" zatím nic nevytvořil."}),
    P.priv ? el("h2",{text: me ? "Koupené materiály" : "Koupil(a)"}) : null,
    P.priv ? (P.bought.length ? el("div",{class:"cards"}, P.bought.map(function(q){ return quizCard(q, true); }))
                              : el("p",{class:"muted",text:"Zatím nic."})) : null,
    P.priv ? el("h2",{text:"Historie kreditů"}) : null,
    P.priv ? (P.log.length ? el("ul",{class:"history"}, P.log.map(function(x){
        return el("li",{},[
          el("span",{class:"txt"},[el("span",{text:x.reason}), el("span",{class:"muted small",text:fmtDate(x.created_at)})]),
          el("strong",{class: x.amount > 0 ? "plus" : "minus", text:(x.amount > 0 ? "+" : "−")+Math.abs(x.amount)})
        ]);
      })) : el("p",{class:"muted",text:"Zatím žádné pohyby."})) : null
  ];
}

/* ---------- správa (admin) ---------- */
function openAdmin(){
  S.adm = {loading:true, userQ:""};
  var cnt = function(t, f){ var q = sb.from(t).select("*",{count:"exact",head:true}); return f ? f(q) : q; };
  Promise.all([
    cnt("profiles"), cnt("quizzes"), cnt("purchases"), cnt("plays"),
    sb.from("reports").select("id,reason,created_at,quiz_id,reporter_id,quizzes(title,author_id),profiles!reports_reporter_id_fkey(nickname)").eq("status","open").order("created_at",{ascending:false}).limit(200),
    sb.from("profiles").select("id,nickname,credits,is_admin,created_at,avatar_v").order("credits",{ascending:false}).limit(1000)
  ]).then(function(r){
    var e = r.map(function(x){ return x.error; }).filter(Boolean)[0];
    S.adm = e ? {error:dbErrText(e)} : {users:r[0].count||0, quizzes:r[1].count||0, purchases:r[2].count||0, plays:r[3].count||0,
      reports:r[4].data||[], people:r[5].data||[], userQ:""};
    if (!e) S.openReports = S.adm.reports.length;
    if (S.view === "admin") render();
  });
}

function resolveReport(rep, status, btn){
  btn.disabled = true;
  sb.from("reports").update({status:status, resolved_by:S.me, resolved_at:new Date().toISOString()}).eq("id", rep.id).then(function(r){
    if (r.error){ btn.disabled = false; return err("err", dbErrText(r.error)); }
    S.adm.reports = S.adm.reports.filter(function(x){ return x.id !== rep.id; });
    S.openReports = S.adm.reports.length;
    err("ok", status === "resolved" ? "Nahlášení označeno jako vyřešené." : "Nahlášení zamítnuto.");
  });
}

function adminView(){
  if (!isAdmin()) return [el("div",{class:"panel"},[el("h2",{text:"Sem má přístup jen správce."})])];
  var A = S.adm || {};
  if (A.loading) return [el("div",{class:"panel"},[el("h2",{text:"Načítám přehled…"})])];
  if (A.error) return [el("p",{class:"msg err",text:A.error})];
  var credits = A.people.reduce(function(a,p){ return a + (p.credits||0); }, 0);
  var f = A.userQ.trim().toLowerCase();
  var people = f ? A.people.filter(function(p){ return p.nickname.toLowerCase().indexOf(f) >= 0; }) : A.people;
  var userSearch = el("input",{type:"search",id:"adm-user-q",placeholder:"Hledat uživatele","aria-label":"Hledat uživatele",oninput:function(e){ A.userQ = e.target.value; render(); }});
  userSearch.value = A.userQ;

  return [
    el("div",{class:"top"},[el("div",{},[el("span",{class:"label",text:"Správa"}), el("h1",{text:"Přehled webu"})]), el("button",{class:"btn ghost",text:"Obnovit",onclick:function(){ openAdmin(); render(); }})]),
    el("dl",{class:"stats five"},[
      el("div",{},[el("dt",{text:"Uživatelé"}), el("dd",{text:String(A.users)})]),
      el("div",{},[el("dt",{text:"Kvízy"}), el("dd",{text:String(A.quizzes)})]),
      el("div",{},[el("dt",{text:"Nákupy"}), el("dd",{text:String(A.purchases)})]),
      el("div",{},[el("dt",{text:"Odehráno"}), el("dd",{text:String(A.plays)})]),
      el("div",{},[el("dt",{text:"Kredity v oběhu"}), el("dd",{text:String(credits)})])
    ]),
    msgEl(),
    el("h2",{text:"Nahlášené kvízy ("+A.reports.length+")"}),
    A.reports.length ? el("ul",{class:"reports"}, A.reports.map(function(rep){
      var title = (rep.quizzes && rep.quizzes.title) || "Smazaný kvíz";
      return el("li",{class:"panel"},[
        el("div",{class:"row",style:"justify-content:space-between"},[
          el("a",{class:"plink",href:"#q/"+rep.quiz_id,text:title}),
          el("span",{class:"muted small",text:fmtDate(rep.created_at)})
        ]),
        el("p",{class:"reason",text:"„"+rep.reason+"“"}),
        el("span",{class:"muted small"},["Nahlásil(a) ", profileLink(rep.reporter_id, rep.profiles && rep.profiles.nickname)]),
        el("div",{class:"row"},[
          el("button",{class:"btn sm danger-btn",text:"Smazat kvíz",onclick:function(e){ confirmDelete(e.currentTarget, rep.quiz_id); }}),
          el("button",{class:"btn sm",text:"Vyřešeno",onclick:function(e){ resolveReport(rep, "resolved", e.currentTarget); }}),
          el("button",{class:"btn ghost sm",text:"Zamítnout",onclick:function(e){ resolveReport(rep, "dismissed", e.currentTarget); }})
        ])
      ]);
    })) : el("p",{class:"muted",text:"Nic nahlášeného. Paráda."}),
    el("div",{class:"top"},[el("h2",{text:"Uživatelé ("+A.people.length+")"})]),
    userSearch,
    el("div",{class:"tablewrap"},[el("table",{class:"utable"},[
      el("thead",{},[el("tr",{},[el("th",{text:"Přezdívka"}), el("th",{class:"num",text:"Kredity"}), el("th",{text:"Registrace"})])]),
      el("tbody",{}, people.map(function(p){
        return el("tr",{},[
          el("td",{},[el("span",{class:"by"},[avatarEl(p.id, p, "xs"), profileLink(p.id, p.nickname), p.is_admin ? el("span",{class:"pill admin",text:"Správce"}) : null])]),
          el("td",{class:"num",text:String(p.credits||0)}),
          el("td",{text:fmtDate(p.created_at)})
        ]);
      }))
    ])]),
    el("p",{class:"muted small",text:"Kredity přidáš na profilu uživatele, klikni na jeho přezdívku."})
  ];
}

/* ---------- otevření kvízu ---------- */
function openQuiz(id, then){
  Promise.all([
    sb.from("quizzes").select(QUIZ_COLS).eq("id", id).single(),
    sb.from("quiz_content").select("questions,enc").eq("quiz_id", id).maybeSingle()
  ]).then(function(r){
    var e = r[0].error || r[1].error;
    if (e) return err("err", dbErrText(e));
    var q = r[0].data, c = r[1].data;
    if (!c){
      if (!canOpen(q)){ S.buyFor = q; go("buy"); return; }
      return err("err","Otázky tohohle kvízu se nepovedlo načíst.");
    }
    q.questions = c.questions; q.enc = c.enc;
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
    el("div",{},[el("a",{class:"plink",href:"#q/"+q.id,text:"Zpět na kvíz"})])
  ]);
}

/* ---------- hraní ---------- */
function startPlay(q, questions, only){
  var idx = only || questions.map(function(_,i){ return i; });
  S.play = { quiz:q, title:q.title, qs:questions, order:shuffle(idx), i:0, score:0, picked:null, opts:null, wrong:[], mistakesRound:!!only, saved:false };
  prep(); go("play");
}
function prep(){ var P = S.play, q = P.qs[P.order[P.i]]; P.opts = q ? shuffle(q.a.map(function(_,i){ return i; })) : null; P.picked = null; }

function finishRound(P){
  if (P.saved || P.mistakesRound) return;
  P.saved = true;
  sb.from("plays").insert({quiz_id:P.quiz.id, score:P.score, total:P.order.length}).then(function(r){
    if (r.error) return;
    S.quizzes.forEach(function(q){ if (q.id === P.quiz.id){ q.play_count = (q.play_count||0) + 1; q.score_sum = (q.score_sum||0) + P.score; q.total_sum = (q.total_sum||0) + P.order.length; } });
  });
}

function playView(){
  var P = S.play;
  var head = el("div",{class:"top"},[el("div",{},[el("span",{class:"label",text: P.mistakesRound ? "Opakování chyb" : "Procvičování"}), el("h1",{text:P.title||"Kvíz"})]), el("a",{class:"plink",href:"#q/"+P.quiz.id,text:"Ukončit"})]);
  if (!P.qs.length) return [head, el("div",{class:"panel"},[el("h2",{text:"Tenhle kvíz je zatím prázdný"})])];
  if (P.i >= P.order.length){
    finishRound(P);
    var p = pct(P.score, P.order.length), nw = P.wrong.length;
    return [head, el("div",{class:"panel"},[
      el("span",{class:"label",text:"Hotovo"}),
      el("div",{class:"score",text:P.score+" / "+P.order.length}),
      el("p",{class:"muted",text: p===100 ? "Všechno správně. Paráda!" : p>=70 ? "Dobrý, "+p+" % správně." : p+" % správně. Zkus to ještě jednou."}),
      el("div",{class:"row"},[
        nw ? el("button",{class:"btn",text:"Opakovat chyby ("+nw+")",onclick:function(){ startPlay(P.quiz, P.qs, P.wrong.slice()); }}) : null,
        el("button",{class: nw ? "btn ghost" : "btn",text:"Znovu celý kvíz",onclick:function(){ startPlay(P.quiz, P.qs); }}),
        P.quiz.author_id !== S.me ? el("a",{class:"btn ghost",href:"#q/"+P.quiz.id,text:"Ohodnotit kvíz"}) : null,
        el("a",{class:"btn ghost",href:"#kvizy",text:"Jiný kvíz"})
      ])
    ])];
  }
  var qi = P.order[P.i], q = P.qs[qi];
  var answers = el("div",{class:"answers"}, P.opts.map(function(ai, pos){
    var cls = "ans";
    if (P.picked !== null){ if (ai === q.correct) cls += " good"; else if (ai === P.picked) cls += " bad"; }
    return el("button",{class:cls,disabled:P.picked !== null,onclick:function(){
      if (P.picked !== null) return;
      P.picked = ai;
      if (ai === q.correct) P.score++; else P.wrong.push(qi);
      render();
    }},[el("span",{class:"letter",text:LETTERS[pos]}), el("span",{text:q.a[ai]})]);
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
  S.edit = { id: q ? q.id : null, title: q ? q.title : "", pw: pw, price: q ? (q.price || 0) : 0,
             subject: q ? (q.subject || "") : "", tags: q && q.tags ? q.tags.join(", ") : "",
             questions: questions.map(function(x){ return {q:x.q, a:x.a.slice(), correct:x.correct}; }),
             draft: {q:"", a:["","",""], correct:0} };
  go("edit");
}

function parseTags(t){
  var seen = {}, out = [];
  (t || "").split(/[,;\n]/).forEach(function(x){
    x = x.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-").slice(0, 20);
    if (x && !seen[x]){ seen[x] = true; out.push(x); }
  });
  return out;
}

/* Rozpozná otázky z textu. Umí dva tvary:
   1) očíslované otázky s odpověďmi A) B) C) … (2 až 6), správná označená * / (správně) / ✓,
      řádkem „Správně: B“ nebo klíčem na konci („Klíč: 1B 2A 3C“),
   2) jednoduchý tvar: otázka, pod ní 2 až 6 odpovědí, správná s *, mezi otázkami prázdný řádek. */
var MARK_RE = /\s*(\*|✓|✔|\((?:správně|spravne|správná|spravna)\))\s*$/i;
function stripMark(t){ var m = MARK_RE.exec(t); return m ? {t:t.slice(0, m.index).trim(), ok:true} : {t:t.trim(), ok:false}; }
function short(t){ return t.length > 40 ? t.slice(0, 40) + "…" : t; }
function letterIdx(c){ return c.toUpperCase().charCodeAt(0) - 65; }

function parseBulk(text){
  var lines = text.replace(/\r/g,"").split("\n").map(function(s){ return s.replace(/\s+/g," ").trim(); });
  var lettered = lines.filter(function(l){ return /^\*?\s*[A-Fa-f]\s*[\)\.:]\s+\S/.test(l); }).length >= 2;
  return lettered ? parseLettered(lines) : parsePlain(text);
}

function parseLettered(lines){
  var out = [], errs = [], cur = null, last = -1, title = "", keys = {};
  var KEY_LINE = /^(?:spr[aá]vn[ěeáa]\s*(?:odpověď|odpoved)?|odpověď|odpoved|řešení|reseni)\s*[:\-–]\s*([A-Fa-f])(?![A-Za-zÀ-ž])/i;
  var KEY_BLOCK = /^(?:klíč|klic|řešení|reseni|správné odpovědi|spravne odpovedi)(?=[\s:]|$)\s*:?\s*(.*)$/i;
  var ANSWER = /^(\*)?\s*([A-Fa-f])\s*[\)\.:]\s*(.*)$/;
  var NUMBERED = /^(?:otázka\s*)?(\d{1,3})\s*[\.\):]\s*(.*)$/i;
  var inKey = false;

  function start(q, num){ finish(); cur = {q:q, num:num, a:[], correct:-1}; last = -1; }
  function finish(){
    if (!cur) return;
    if (!cur.a.length){ if (!out.length && !title && cur.q) title = cur.q; }
    else out.push(cur);
    cur = null;
  }
  function readKeys(t){ var re = /(\d{1,3})\s*[\.\)\-:–]?\s*([A-Fa-f])(?![A-Za-zÀ-ž])/g, m; while ((m = re.exec(t))) keys[+m[1]] = letterIdx(m[2]); }

  lines.forEach(function(l){
    if (!l) return;
    var m;
    if (!inKey && cur && (m = KEY_LINE.exec(l))){ cur.correct = letterIdx(m[1]); return; }
    if ((m = KEY_BLOCK.exec(l)) && !ANSWER.test(l)){ finish(); inKey = true; readKeys(m[1]); return; }
    if (inKey){ readKeys(l); return; }
    if ((m = ANSWER.exec(l)) && cur){
      var idx = letterIdx(m[2]), s = stripMark(m[3]);
      cur.a[idx] = s.t; last = idx;
      if (m[1] || s.ok) cur.correct = idx;
      return;
    }
    if ((m = NUMBERED.exec(l)) && m[2]){ start(m[2], +m[1]); return; }
    if (cur && last < 0){ cur.q += " " + l; return; }
    if (cur && last >= 0){ var w = stripMark(l); cur.a[last] += " " + w.t; if (w.ok) cur.correct = last; return; }
    if (!cur && !out.length && !title){ title = l; return; }
    start(l, null);
  });
  finish();

  var qs = [];
  out.forEach(function(c){
    if (c.correct < 0 && c.num !== null && keys[c.num] !== undefined) c.correct = keys[c.num];
    var a = [];
    for (var i = 0; i < c.a.length; i++){
      if (c.a[i] === undefined || c.a[i] === ""){ a = null; break; }
      a.push(c.a[i]);
    }
    if (!a){ errs.push("U „"+short(c.q)+"“ chybí některá odpověď (písmena musí jít po sobě A, B, C…)."); return; }
    if (a.length < MIN_A || a.length > MAX_A){ errs.push("„"+short(c.q)+"“ má "+a.length+" "+plural(a.length,"odpověď","odpovědi","odpovědí")+", musí mít 2 až 6."); return; }
    if (c.correct < 0 || c.correct >= a.length){ errs.push("U „"+short(c.q)+"“ není označená správná odpověď."); return; }
    qs.push({q:c.q, a:a, correct:c.correct});
  });
  return {qs:qs, errs:errs, title:title};
}

function parsePlain(text){
  var blocks = text.replace(/\r/g,"").split(/\n\s*\n/), out = [], errs = [];
  blocks.forEach(function(b, bi){
    var lines = b.split("\n").map(function(s){ return s.trim(); }).filter(Boolean);
    if (!lines.length) return;
    var n = lines.length - 1;
    if (n < MIN_A || n > MAX_A){ errs.push("Blok "+(bi+1)+" má "+n+" "+plural(n,"odpověď","odpovědi","odpovědí")+", musí mít 2 až 6."); return; }
    var correct = -1, a = lines.slice(1).map(function(s, i){
      if (s[0] === "*"){ correct = i; return s.slice(1).trim(); }
      var x = stripMark(s); if (x.ok) correct = i; return x.t;
    });
    if (correct < 0){ errs.push("V bloku "+(bi+1)+" není označená správná odpověď hvězdičkou *."); return; }
    out.push({q:lines[0].replace(/^\d{1,3}\s*[\.\)]\s*/, ""), a:a, correct:correct});
  });
  return {qs:out, errs:errs, title:""};
}

/* Text z PDF: pdf.js se načte až při prvním importu. */
var pdfLib = null;
function pdfToText(file){
  var load = pdfLib ? Promise.resolve(pdfLib) : import("./vendor/pdfjs-6.3.289/pdf.min.mjs").then(function(lib){
    lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs-6.3.289/pdf.worker.min.mjs", document.baseURI).href;
    return (pdfLib = lib);
  });
  return Promise.all([load, file.arrayBuffer()]).then(function(r){
    return r[0].getDocument({data:new Uint8Array(r[1]), isEvalSupported:false}).promise;
  }).then(function(doc){
    var pages = [];
    for (var i = 1; i <= doc.numPages; i++) pages.push(doc.getPage(i).then(function(p){ return p.getTextContent(); }));
    return Promise.all(pages);
  }).then(function(contents){
    return contents.map(function(tc){
      var out = "", lastY = null;
      tc.items.forEach(function(it){
        if (typeof it.str !== "string") return;
        var y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !/\n$/.test(out)) out += "\n";
        out += it.str;
        if (it.hasEOL) out += "\n";
        if (y !== null) lastY = y;
      });
      return out;
    }).join("\n\n");
  });
}

function importText(text, D, source){
  var r = parseBulk(text);
  if (!r.qs.length){
    err("err", (source ? "V souboru „"+source+"“ jsem nenašel žádnou otázku. " : "Nenašel jsem žádnou otázku. ") + (r.errs.length ? r.errs.slice(0,3).join(" ") : "Zkontroluj, že má formát jako v ukázce."), "bulk");
    return;
  }
  D.questions = D.questions.concat(r.qs);
  if (!D.title.trim()) D.title = r.title || (source ? source.replace(/\.[^.]+$/, "") : "");
  var msg = "Přidáno "+r.qs.length+" "+plural(r.qs.length,"otázka","otázky","otázek")+". Zkontroluj je v seznamu nahoře a ulož.";
  if (r.errs.length) msg += " Přeskočeno "+r.errs.length+": "+r.errs.slice(0,3).join(" ")+(r.errs.length>3?" …":"");
  err(r.errs.length ? "err" : "ok", msg, "bulk");
}

var CLAUDE_PROMPT = "Udělej mi test z tématu [TÉMA] jako PDF. Bude mít [POČET] otázek. "
  + "Každou otázku očísluj (1., 2., …) a pod ni napiš 2 až 6 odpovědí označených A), B), C), D)…, každou na vlastní řádek. "
  + "Za správnou odpověď dej na konec řádku hvězdičku *. Nic jiného do testu nepiš.";

function editView(){
  var D = S.edit, N = D.draft;
  var title = el("input",{type:"text",id:"ed-title",maxlength:"80",placeholder:"Např. Botanika – rostlinná pletiva",oninput:function(e){ D.title = e.target.value; }});
  title.value = D.title;
  var subjects = {}; SUBJECTS.forEach(function(s){ subjects[s] = true; }); S.quizzes.forEach(function(q){ if (q.subject) subjects[q.subject] = true; });
  var subj = el("input",{type:"text",id:"ed-subject",maxlength:"40",list:"subject-list",placeholder:"Vyber nebo napiš předmět",oninput:function(e){ D.subject = e.target.value; }});
  subj.value = D.subject;
  var subjList = el("datalist",{id:"subject-list"}, Object.keys(subjects).sort().map(function(s){ return el("option",{value:s}); }));
  var tags = el("input",{type:"text",id:"ed-tags",maxlength:"120",placeholder:"Např. zkouška, pletiva, 1. ročník",oninput:function(e){ D.tags = e.target.value; }});
  tags.value = D.tags;
  var pw = el("input",{type:"password",id:"ed-pw",autocomplete:"new-password",placeholder:"Nech prázdné, když má být kvíz bez hesla",oninput:function(e){ D.pw = e.target.value; }});
  pw.value = D.pw;
  var priceIn = el("input",{type:"number",id:"ed-price",min:"0",max:"10000",step:"1",inputmode:"numeric",oninput:function(e){ D.price = e.target.value; }});
  priceIn.value = D.price;

  var list = D.questions.length ? el("ol",{class:"qlist"}, D.questions.map(function(q, i){
    return el("li",{},[
      el("div",{class:"txt"},[el("strong",{text:(i+1)+". "+q.q}), el("div",{class:"small muted"}, q.a.map(function(a, ai){ return el("div",{class: ai===q.correct ? "ok" : "", text:LETTERS[ai]+") "+a+(ai===q.correct?"  ✓":"")}); }))]),
      el("button",{class:"btn danger",text:"Smazat","aria-label":"Smazat otázku "+(i+1),onclick:function(){ D.questions.splice(i,1); render(); }})
    ]);
  })) : el("p",{class:"muted",text:"Zatím žádné otázky. Přidej první níž nebo nahraj PDF."});

  var nq = el("input",{type:"text",id:"new-q",placeholder:"Např. Kolik je 7 × 8?",oninput:function(e){ N.q = e.target.value; }});
  nq.value = N.q;
  var rows = N.a.map(function(val, i){
    var inp = el("input",{type:"text",id:"new-a"+i,placeholder:"Odpověď "+LETTERS[i],oninput:function(e){ N.a[i] = e.target.value; }});
    inp.value = val;
    var radio = el("input",{type:"radio",name:"new-correct",id:"new-c"+i,"aria-label":"Odpověď "+LETTERS[i]+" je správná",checked:N.correct===i,onchange:function(){ N.correct = i; }});
    var rm = N.a.length > MIN_A ? el("button",{class:"btn link small danger-link",type:"button","aria-label":"Odebrat odpověď "+LETTERS[i],text:"Odebrat",onclick:function(){
      N.a.splice(i,1); if (N.correct >= N.a.length || N.correct === i) N.correct = 0; else if (N.correct > i) N.correct--; render();
    }}) : null;
    return el("div",{class:"opt"},[radio, el("span",{class:"optl",text:LETTERS[i]}), inp, rm]);
  });
  var addForm = el("form",{class:"panel",onsubmit:function(e){
    e.preventDefault();
    var a = N.a.map(function(x){ return x.trim(); });
    if (!N.q.trim() || a.some(function(x){ return !x; })) return err("err","Vyplň otázku a všechny odpovědi (prázdné odeber).", "add");
    D.questions.push({q:N.q.trim(), a:a, correct:N.correct});
    D.draft = {q:"", a:a.map(function(){ return ""; }), correct:0};
    err("ok","Otázka přidaná. Nezapomeň uložit.", "add"); focusLater("new-q");
  }},[
    el("h2",{text:"Přidat otázku"}),
    el("div",{class:"field"},[el("label",{class:"label",for:"new-q",text:"Otázka"}), nq]),
    el("div",{class:"field"},[el("span",{class:"label",text:"Odpovědi (puntík = správná)"})].concat(rows)),
    N.a.length < MAX_A ? el("div",{},[el("button",{class:"btn link small",type:"button",text:"+ Přidat odpověď",onclick:function(){ N.a.push(""); render(); focusLater("new-a"+(N.a.length-1)); }})]) : null,
    msgEl("add"),
    el("div",{class:"row"},[el("button",{class:"btn ghost",type:"submit",text:"Přidat do seznamu"})])
  ]);

  var bulk = el("textarea",{id:"bulk",placeholder:"1. Hlavní město Francie?\nA) Paříž *\nB) Lyon\nC) Marseille\nD) Nice\n\n2. Kolik je 7 × 8?\nA) 54\nB) 56 *"});
  var file = el("input",{type:"file",id:"bulk-file",accept:".pdf,.txt,application/pdf,text/plain"});
  var fileBtn = el("label",{class:"btn",for:"bulk-file",tabindex:"0",role:"button",text:"Nahrát PDF",onkeydown:function(e){ if (e.key==="Enter"||e.key===" "){ e.preventDefault(); file.click(); } }});
  file.hidden = true;
  file.addEventListener("change", function(){
    var f = file.files && file.files[0]; if (!f) return;
    file.value = "";
    fileBtn.textContent = "Čtu soubor…";
    var isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
    (isPdf ? pdfToText(f) : f.text()).then(function(t){ importText(t, D, f.name); },
      function(){ err("err","Soubor „"+f.name+"“ se nepovedlo přečíst. Je to opravdu PDF s textem (ne naskenovaný obrázek)?", "bulk"); });
  });
  var promptBox = el("textarea",{id:"claude-prompt",readonly:true,style:"min-height:96px","aria-label":"Zadání pro Clauda"});
  promptBox.value = CLAUDE_PROMPT;
  var copyBtn = el("button",{class:"btn ghost sm",type:"button",text:"Zkopírovat zadání pro Clauda",onclick:function(e){
    var b = e.currentTarget;
    var done = function(){ b.textContent = "Zkopírováno"; setTimeout(function(){ if (b.isConnected) b.textContent = "Zkopírovat zadání pro Clauda"; }, 2000); };
    if (navigator.clipboard) navigator.clipboard.writeText(CLAUDE_PROMPT).then(done, function(){ promptBox.select(); });
    else promptBox.select();
  }});
  var bulkPanel = el("div",{class:"panel"},[
    el("h2",{text:"Nahrát test z PDF"}),
    el("p",{class:"muted small",text:"Nahraj PDF s testem a otázky se doplní samy. Otázky očísluj, odpovědi označ A), B), C)… (2 až 6) a za správnou dej hvězdičku *. Funguje i řádek „Správně: B“ pod otázkou nebo klíč na konci, třeba „Klíč: 1A 2C 3B“."}),
    el("div",{class:"row"},[fileBtn, file]),
    el("details",{},[
      el("summary",{class:"small",style:"cursor:pointer;font-weight:700",text:"Jak si nechat test udělat od Clauda"}),
      el("div",{class:"field",style:"margin-top:10px"},[
        el("p",{class:"muted small",text:"Zkopíruj tohle zadání do Clauda, doplň téma a počet otázek. PDF, které ti udělá, pak nahraj sem."}),
        promptBox,
        el("div",{class:"row"},[copyBtn])
      ])
    ]),
    el("span",{class:"label",style:"margin-top:6px",text:"Nebo vlož text"}),
    bulk,
    el("div",{class:"row"},[el("button",{class:"btn ghost",text:"Přidat z textu",onclick:function(){ importText(bulk.value, D, null); }})]),
    msgEl("bulk")
  ]);

  var saveBtn = el("button",{class:"btn",text:"Uložit kvíz",onclick:function(){ saveQuiz(saveBtn); }});
  return [
    el("div",{class:"top"},[el("h1",{text: D.id ? "Upravit kvíz" : "Nový kvíz"}), el("a",{class:"plink",href: D.id ? "#q/"+D.id : "#kvizy",text:"Zpět bez uložení"})]),
    el("div",{class:"panel"},[
      el("div",{class:"field"},[el("label",{class:"label",for:"ed-title",text:"Název kvízu"}), title]),
      el("div",{class:"grid2 even"},[
        el("div",{class:"field"},[el("label",{class:"label",for:"ed-subject",text:"Předmět"}), subj, subjList]),
        el("div",{class:"field"},[el("label",{class:"label",for:"ed-tags",text:"Štítky"}), tags, el("p",{class:"muted small",text:"Odděl čárkou, nejvíc 5."})])
      ]),
      el("div",{class:"grid2 even"},[
        el("div",{class:"field"},[el("label",{class:"label",for:"ed-price",text:"Cena v kreditech"}), priceIn, el("p",{class:"muted small",text:"0 = zdarma. Kredity z prodeje dostaneš ty."})]),
        el("div",{class:"field"},[el("label",{class:"label",for:"ed-pw",text:"Heslo (nepovinné)"}), pw, el("p",{class:"muted small",text:"S heslem se otázky uloží zašifrované."})])
      ]),
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
  var price = Number(D.price);
  if (!Number.isInteger(price) || price < 0 || price > 10000){ err("err","Cena musí být celé číslo od 0 do 10 000."); return focusLater("ed-price"); }
  var tags = parseTags(D.tags);
  if (tags.length > 5) return err("err","Štítků může být nejvíc 5.");
  btn.disabled = true; btn.textContent = "Ukládám…";
  var row = {title:D.title.trim(), question_count:D.questions.length, price:price, locked:!!D.pw,
             subject:D.subject.trim().slice(0, 40) || null, tags:tags, updated_at:new Date().toISOString()};
  var content = D.pw ? encrypt(D.questions, D.pw).then(function(blob){ return {questions:null, enc:blob}; })
                     : Promise.resolve({questions:D.questions, enc:null});
  var created = false;
  content.then(function(c){
    var saveRow = D.id ? sb.from("quizzes").update(row).eq("id", D.id).then(function(r){ if (r.error) throw r.error; return D.id; })
                       : sb.from("quizzes").insert(row).select("id").single().then(function(r){ if (r.error) throw r.error; created = true; return r.data.id; });
    return saveRow.then(function(id){
      c.quiz_id = id;
      return sb.from("quiz_content").upsert(c, {onConflict:"quiz_id"}).then(function(r){
        if (r.error){
          if (created) sb.from("quizzes").delete().eq("id", id);
          throw r.error;
        }
        return id;
      });
    });
  }).then(function(id){
    S.msg = {kind:"ok", text:"Kvíz „"+D.title.trim()+"“ je uložený a ostatní ho uvidí v seznamu."};
    nav("#q/"+id, true);
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "Uložit kvíz";
    err("err", dbErrText(e));
  });
}

/* ---------- start ---------- */
function onSession(session){
  S.session = session;
  if (!session){
    S.me = null; S.profile = null; S.quizzes = []; S.people = null; S.prof = null; S.owned = {}; S.following = {}; S.openReports = 0;
    if (S.view !== "auth") go("auth", true);
    return;
  }
  if (S.me === session.user.id && S.view !== "loading" && S.view !== "auth") return;
  S.me = session.user.id;
  Promise.all([refreshMe(), loadOwned(), loadFollowing()]).then(function(){
    if (!S.profile) S.profile = {nickname: (session.user.user_metadata && session.user.user_metadata.nickname) || "", credits:0, is_admin:false};
    S.msg = null; route();
  });
}

sb.auth.onAuthStateChange(function(event, session){
  /* volání Supabase uvnitř callbacku se odkládá, aby se nezaseklo přihlašování */
  setTimeout(function(){ onSession(session); }, 0);
});
})();
