// COPRO — POST /api/analyse
// Lot 1 : QUALIFICATION par lecture d'image des pièces SANS couche de texte
// (règlements anciens scannés, procès-verbaux photocopiés). Les pièces à
// couche de texte sont qualifiées dans le navigateur, sans appel ici.
//
// Même garde-fou que la passe 2 de FUSION :
//   - rien ne part sans validation explicite d'un compte autorisé ;
//   - l'autorisation est vérifiée ICI, côté serveur : le navigateur envoie son
//     jeton Google (celui de la connexion Drive), on demande à Google le
//     courriel qu'il porte, et on le compare à COPRO_AUTORISES.
//
// Variables d'environnement du projet Vercel `copro` :
//   ANTHROPIC_API_KEY   obligatoire — clé API Anthropic
//   COPRO_AUTORISES     obligatoire — courriels autorisés, séparés par des virgules
//   COPRO_MODELE        facultatif  — modèle appelé (défaut : claude-sonnet-5)
//   COPRO_COUT_PAGE_EUR facultatif  — coût estimé par page affiché avant envoi (défaut : 0.03)
//
// Deux actions :
//   { action:"estimer", jeton }                          → { autorise, courriel, modele, coutPageEur, configure, motif }
//   { action:"qualifier", jeton, nom, pages:[{numero, image}] }
//                                                        → { type, date, dateAssemblee, assembleesCitees, confiance }
//   { action:"analyser", jeton, nature, texte?, pages?, contexte }  (lot 2)
//        nature = "reglement" : extraits des zones ciblées + extraits des lots → synthèse par zone, fiche par lot
//        nature = "pv"        : texte (ou images) d'un procès-verbal → résolutions, travaux, procédures, dettes
//        nature = "financier" : appel de fonds, état daté, impayés, budget, fiche synthétique → montants et échéances
//   L'extraction des zones du règlement (par article, à défaut par expression) se fait dans le
//   navigateur : seuls les extraits utiles partent ici, jamais le règlement entier.

const MODELE_DEFAUT = 'claude-sonnet-5';
const COUT_PAGE_DEFAUT = 0.03;
const PAGES_MAX = 3;
const PAGES_MAX_ANALYSE = 6;
const SIGNES_MAX = 120000;
const API = 'https://api.anthropic.com/v1/messages';
const TYPES = ['RCP', 'RCPM', 'PVAG', 'AF', 'EDA', 'IMP', 'CE', 'DTG', 'DPC', 'BUD', 'FSC', 'CTR', 'EHF', 'AQ'];

function autorises() {
  return String(process.env.COPRO_AUTORISES || '')
    .split(/[,;\s]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);
}

async function courrielDuJeton(jeton) {
  if (!jeton) return null;
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + jeton } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.user && j.user.emailAddress ? String(j.user.emailAddress).toLowerCase() : null;
}

function reglages() {
  return {
    modele: process.env.COPRO_MODELE || MODELE_DEFAUT,
    coutPageEur: Number(process.env.COPRO_COUT_PAGE_EUR) > 0 ? Number(process.env.COPRO_COUT_PAGE_EUR) : COUT_PAGE_DEFAUT,
    // coût estimé par million de jetons, affiché avant envoi (entrée / sortie)
    coutEntreeMJ: Number(process.env.COPRO_COUT_ENTREE_MJ) > 0 ? Number(process.env.COPRO_COUT_ENTREE_MJ) : 3,
    coutSortieMJ: Number(process.env.COPRO_COUT_SORTIE_MJ) > 0 ? Number(process.env.COPRO_COUT_SORTIE_MJ) : 15
  };
}

const CONSIGNE = `Tu qualifies des pièces de copropriété françaises à partir de l'image de leurs premières pages. Tu rends UNIQUEMENT un objet JSON, sans texte autour, sans balises de code.

Types possibles (un seul) :
- "RCP"  : règlement de copropriété et/ou état descriptif de division (acte d'origine)
- "RCPM" : acte modificatif du règlement de copropriété ou de l'état descriptif de division
- "PVAG" : procès-verbal d'assemblée générale des copropriétaires
- "AF"   : appel de fonds ou appel de charges
- "EDA"  : état daté ou pré-état daté
- "IMP"  : mise en demeure, relance ou procédure pour charges impayées
- "CE"   : carnet d'entretien de l'immeuble
- "DTG"  : diagnostic technique global
- "DPC"  : diagnostic des parties communes (amiante, plomb, termites...)
- "BUD"  : budget prévisionnel ou comptes approuvés du syndicat
- "FSC"  : fiche synthétique de la copropriété
- "CTR"  : contrat liant le syndicat (ascenseur, chauffage, gardiennage, entretien...)
- "EHF"  : état hypothécaire (relevé des formalités du service de la publicité foncière)
- "AQ"   : impossible à qualifier

Structure attendue :
{
  "type": "PVAG",
  "date": "JJ/MM/AAAA",              // date propre de la pièce (acte, appel, diagnostic...) ; null si illisible
  "dateAssemblee": "JJ/MM/AAAA",     // pour un procès-verbal seulement : date de l'assemblée tenue ; sinon null
  "assembleesCitees": ["JJ/MM/AAAA"],// pour un procès-verbal : dates d'AUTRES assemblées citées dans le texte visible ; sinon []
  "confiance": "haute" | "moyenne" | "faible"
}

Règles : ne devine jamais une date ; null plutôt qu'une date fausse. Un humain valide ensuite chaque qualification à l'écran.`;

function nettoyerJSON(texte) {
  let t = String(texte || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
function date(v) { return typeof v === 'string' && DATE_RE.test(v.trim()) ? v.trim() : null; }

async function qualifier(res, corps, courriel) {
  const { modele } = reglages();
  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY absente du projet Vercel' });
  const pages = Array.isArray(corps.pages) ? corps.pages.filter((p) => p && Number.isInteger(p.numero) && typeof p.image === 'string' && p.image.length > 100) : [];
  if (!pages.length) return res.status(400).json({ erreur: 'pages vide' });
  if (pages.length > PAGES_MAX) return res.status(413).json({ erreur: `trop de pages (${pages.length} > ${PAGES_MAX})` });

  const contenu = [{ type: 'text', text: `Pièce déposée : ${corps.nom || 'sans nom'}. Voici ses ${pages.length} première(s) page(s).` }];
  for (const p of pages) {
    contenu.push({ type: 'text', text: `Page ${p.numero}` });
    contenu.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.image.replace(/^data:[^,]+,/, '') } });
  }
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modele, max_tokens: 1000, system: CONSIGNE, messages: [{ role: 'user', content: contenu }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ erreur: 'Anthropic — ' + ((j && j.error && j.error.message) || `HTTP ${r.status}`) });
  const texte = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let brut;
  try { brut = nettoyerJSON(texte); }
  catch (e) { return res.status(502).json({ erreur: 'réponse non structurée du modèle', extrait: texte.slice(0, 300) }); }
  return res.status(200).json({
    type: TYPES.includes(brut.type) ? brut.type : 'AQ',
    date: date(brut.date),
    dateAssemblee: date(brut.dateAssemblee),
    assembleesCitees: (Array.isArray(brut.assembleesCitees) ? brut.assembleesCitees : []).map(date).filter(Boolean),
    confiance: ['haute', 'moyenne', 'faible'].includes(brut.confiance) ? brut.confiance : 'faible',
    modele, courriel,
    usage: j.usage ? { entree: j.usage.input_tokens, sortie: j.usage.output_tokens } : null
  });
}


const COMMUN = `Tu travailles pour un office notarial français, sur des pièces de copropriété (loi du 10 juillet 1965, décret du 17 mars 1967). Tu rends UNIQUEMENT un objet JSON, sans texte autour, sans balises de code. Règles : n'invente rien ; null plutôt qu'une valeur douteuse ; dates au format JJ/MM/AAAA ; montants en euros, en chiffres, point décimal, sans espace ni symbole. Rédaction en français soutenu, sobre, au présent, sans formule de politesse.`;

const CONSIGNES = {
  reglement: COMMUN + `

Tu reçois des EXTRAITS d'un règlement de copropriété (et de ses modificatifs), regroupés par ZONE ciblée ; chaque zone indique comment l'extrait a été repéré (par article ou par expression). Tu peux aussi recevoir des extraits de l'état descriptif de division relatifs à certains lots.

Structure attendue :
{
  "zones": [
    {"id": "z1", "synthese": "texte rédigé de deux à cinq phrases résumant ce que prévoit le règlement sur cette zone", "references": "article 5, article 7", "vigilance": "aucune" | "attention" | "alerte", "motif": "pourquoi, si attention ou alerte ; sinon null"}
  ],
  "lots": [
    {"numero": "12", "consistance": "texte tel que décrit à l'état descriptif", "annexes": "cave n° 3, emplacement de stationnement n° 8…" , "tantiemes": "125/10000", "tantiemesParticuliers": "ascenseur : 40/1000…"}
  ],
  "organisations": {"syndicatSecondaire": true | false | null, "unionOuAsl": "texte ou null"}
}

Une entrée "zones" par zone reçue, avec le même identifiant. Si l'extrait ne traite finalement pas du sujet, synthese = null. "vigilance" : "alerte" pour une clause qui restreint fortement l'usage ou la cession du lot (clause d'agrément, interdiction d'activité, droits réservés au promoteur encore en vigueur…), "attention" pour une clause à signaler au client, "aucune" sinon. Une entrée "lots" par lot dont un extrait est fourni ; champs null si l'extrait ne le dit pas.`,

  pv: COMMUN + `

Tu reçois un procès-verbal d'assemblée générale des copropriétaires.

Structure attendue :
{
  "dateAssemblee": "JJ/MM/AAAA",
  "nature": "ordinaire" | "extraordinaire" | null,
  "syndic": "nom du syndic en exercice à l'issue de l'assemblée, ou null",
  "resolutions": [
    {"numero": "3", "objet": "résumé en une phrase", "decision": "adoptée" | "rejetée" | "ajournée" | "sans vote",
     "majorite": "article 24" | "article 25" | "article 25-1" | "article 26" | "unanimité" | null,
     "travaux": null | {"objet": "...", "montant": 123456.00, "financement": "appels de fonds" | "fonds de travaux" | "emprunt collectif" | "non précisé",
                         "echeances": [{"date": "JJ/MM/AAAA", "montant": 0.00, "pourcentage": 25}]},
     "lots": ["12"]}
  ],
  "procedures": [{"objet": "...", "etat": "en cours" | "envisagée" | "terminée"}],
  "empruntCollectif": null | {"montant": 0.00, "objet": "..."},
  "impayes": null | {"montant": 0.00, "date": "JJ/MM/AAAA"},
  "budget": null | {"montant": 0.00, "exercice": "2026"},
  "autorisationsLots": [{"lot": "12", "objet": "travaux autorisés sur ce lot (résumé)"}],
  "pointsAttention": ["phrase courte"]
}

"resolutions" : toutes les résolutions, dans l'ordre. "lots" d'une résolution : les lots expressément visés, sinon []. "procedures" : tout litige, procédure judiciaire, expertise ou recouvrement contentieux mentionné, avec son état à la date de l'assemblée.`,

  financier: COMMUN + `

Tu reçois une pièce financière de copropriété : appel de fonds, état daté ou pré-état daté, mise en demeure ou relance pour impayés, budget prévisionnel ou comptes approuvés, ou fiche synthétique.

Structure attendue :
{
  "datePiece": "JJ/MM/AAAA",
  "syndic": "nom ou null",
  "budgetAnnuel": null | {"montant": 0.00, "exercice": "2026"},
  "impayesCoproprietaires": null | {"montant": 0.00, "date": "JJ/MM/AAAA"},
  "detteSyndicat": {"empruntCollectif": null | 0.00, "decouvert": null | 0.00, "fournisseursEchus": null | 0.00},
  "fondsTravaux": null | 0.00,
  "procedures": [{"objet": "...", "etat": "en cours" | "envisagée" | "terminée"}],
  "appels": [{"lot": "12" | null, "objet": "provision sur charges, travaux de ravalement…", "montant": 0.00, "exigibilite": "JJ/MM/AAAA", "travaux": true | false}],
  "quotePartLot": [{"lot": "12", "chargesAnnuelles": 0.00}],
  "impayesLot": [{"lot": "12", "montant": 0.00}]
}

"impayesCoproprietaires" : le total des impayés de l'ensemble des copropriétaires envers le syndicat (fiche synthétique, annexes comptables, état daté), pas ceux d'un seul lot. "detteSyndicat" : ce que le syndicat doit lui-même (emprunt collectif restant dû, découvert bancaire, dettes fournisseurs échues). "appels" : chaque appel ou échéance avec sa date d'exigibilité.`
};

async function analyser(res, corps, courriel) {
  const { modele } = reglages();
  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY absente du projet Vercel' });
  const consigne = CONSIGNES[corps.nature];
  if (!consigne) return res.status(400).json({ erreur: 'nature inconnue', natures: Object.keys(CONSIGNES) });
  const texte = typeof corps.texte === 'string' ? corps.texte.slice(0, SIGNES_MAX) : '';
  const pages = Array.isArray(corps.pages) ? corps.pages.filter((p) => p && Number.isInteger(p.numero) && typeof p.image === 'string' && p.image.length > 100) : [];
  if (!texte && !pages.length) return res.status(400).json({ erreur: 'ni texte ni pages' });
  if (pages.length > PAGES_MAX_ANALYSE) return res.status(413).json({ erreur: `trop de pages (${pages.length} > ${PAGES_MAX_ANALYSE})` });
  const ctx = corps.contexte || {};
  const contenu = [{ type: 'text', text: `Pièce : ${ctx.nom || 'sans nom'}.` + (Array.isArray(ctx.lots) && ctx.lots.length ? ` Lots analysés pour le client : ${ctx.lots.join(', ')}.` : '') }];
  if (texte) contenu.push({ type: 'text', text: texte });
  for (const p of pages) {
    contenu.push({ type: 'text', text: `Page ${p.numero}` });
    contenu.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.image.replace(/^data:[^,]+,/, '') } });
  }
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modele, max_tokens: 6000, system: consigne, messages: [{ role: 'user', content: contenu }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ erreur: 'Anthropic — ' + ((j && j.error && j.error.message) || `HTTP ${r.status}`) });
  const sortie = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let resultat;
  try { resultat = nettoyerJSON(sortie); }
  catch (e) { return res.status(502).json({ erreur: 'réponse non structurée du modèle', extrait: sortie.slice(0, 300) }); }
  return res.status(200).json({ resultat, modele, courriel, usage: j.usage ? { entree: j.usage.input_tokens, sortie: j.usage.output_tokens } : null });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
    const corps = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const liste = autorises();
    const courriel = await courrielDuJeton(corps.jeton);
    const autorise = Boolean(courriel) && liste.includes(courriel);
    const { modele, coutPageEur, coutEntreeMJ, coutSortieMJ } = reglages();

    if (corps.action === 'estimer') {
      return res.status(200).json({
        autorise, courriel, modele, coutPageEur, coutEntreeMJ, coutSortieMJ, pagesMax: PAGES_MAX, pagesMaxAnalyse: PAGES_MAX_ANALYSE, signesMax: SIGNES_MAX,
        configure: Boolean(process.env.ANTHROPIC_API_KEY) && liste.length > 0,
        motif: !process.env.ANTHROPIC_API_KEY ? 'clé API absente' : !liste.length ? 'aucun compte autorisé (COPRO_AUTORISES vide)' : !courriel ? 'jeton Google absent ou expiré' : !autorise ? 'compte non autorisé' : null
      });
    }
    if (corps.action === 'qualifier') {
      if (!autorise) return res.status(403).json({ erreur: 'Lecture d\'image réservée aux comptes autorisés', courriel: courriel || null });
      return await qualifier(res, corps, courriel);
    }
    if (corps.action === 'analyser') {
      if (!autorise) return res.status(403).json({ erreur: 'Analyse réservée aux comptes autorisés', courriel: courriel || null });
      return await analyser(res, corps, courriel);
    }
    return res.status(400).json({ erreur: 'action inconnue', actions: ['estimer', 'qualifier', 'analyser'] });
  } catch (e) {
    return res.status(500).json({ erreur: e.message || String(e) });
  }
}
