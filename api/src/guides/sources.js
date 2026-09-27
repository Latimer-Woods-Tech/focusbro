/**
 * The evidence ledger — every study, review, book, or professional guidance a
 * guide leans on, as data.
 *
 * Rules:
 *  - A `doi` is present only when it was verified against Crossref on
 *    2026-09-04. Never hand-type one. A source without a DOI is a book, an
 *    essay, or professional guidance, and is typed as such — never dressed up.
 *  - `note` is the honest caveat a careful reader would want: sample, design,
 *    replication status, or "this is a mechanism study in mice". Only claims
 *    that can be defended from the source itself. Where we do not know, we say
 *    nothing rather than guess (R-902: no unverifiable citations).
 *  - `n` is stated only where it was read from the paper's own abstract.
 *
 * The music guide is the canonical case: it cites the 1993 "Mozart effect"
 * letter AND the 2010 meta-analysis that found little to no effect. A ledger
 * that only lists the flattering study is not a ledger.
 */

export const SOURCE_TYPES = Object.freeze({
  study: 'Peer-reviewed study',
  meta: 'Meta-analysis',
  review: 'Review',
  book: 'Book',
  essay: 'Essay',
  guidance: 'Professional guidance',
  report: 'Report',
});

export const AUTHOR = Object.freeze({
  name: 'Adrian Perry',
  role: 'Founder, FocusBro',
  url: 'https://focusbro.net/about.html#author',
});

const doi = (id) => `https://doi.org/${id}`;

export const SOURCES = Object.freeze({
  iom2001: { type: 'report', authors: 'Institute of Medicine, Committee on Military Nutrition Research', year: 2001, title: 'Caffeine for the Sustainment of Mental Task Performance: Formulations for Military Operations', venue: 'National Academies Press', doi: '10.17226/10219', note: 'Puts the mean plasma half-life of caffeine at about 5 hours in healthy adults, with a range of roughly 1.5 to 9.5 hours; smoking shortens it, pregnancy and oral contraceptives lengthen it. The calculator on this page uses these figures.' },
  fredholm1999: { type: 'review', authors: 'Fredholm BB, Bättig K, Holmén J, Nehlig A, Zvartau EE', year: 1999, title: 'Actions of caffeine in the brain with special reference to factors that contribute to its widespread use', venue: 'Pharmacological Reviews 51:83–133', doi: '10.1016/s0031-6997(24)01396-6', note: 'The standard pharmacology review — adenosine-receptor antagonism and the wide individual variation in elimination.' },
  fda_caffeine: { type: 'guidance', authors: 'U.S. Food and Drug Administration', year: null, title: 'Spilling the Beans: How Much Caffeine is Too Much?', venue: 'FDA Consumer Update', url: 'https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much', note: 'The per-drink caffeine figures the calculator presets use (per 12 fl oz: brewed coffee 113–247 mg, black tea 71, green tea 37, soft drink 23–83, energy drink 41–246) and the 400 mg/day figure it cites as not generally associated with negative effects in healthy adults.' },
  ariga2011: { type: 'study', authors: 'Ariga A, Lleras A', year: 2011, title: 'Brief and rare mental "breaks" keep you focused: Deactivation and reactivation of task goals preempt vigilance decrements', venue: 'Cognition 118:439–443', doi: '10.1016/j.cognition.2010.12.007', note: 'Single lab study.' },
  kleitman1982: { type: 'review', authors: 'Kleitman N', year: 1982, title: 'Basic rest-activity cycle — 22 years later', venue: 'Sleep 5:311–317', doi: '10.1093/sleep/5.4.311', note: 'The author reviewing his own hypothesis. The waking-hours version of the cycle is a hypothesis, not an established finding.' },
  aoa_20_20_20: { type: 'guidance', authors: 'American Optometric Association; American Academy of Ophthalmology', year: null, title: 'The 20-20-20 rule for digital eye strain', venue: 'Professional guidance', note: 'A practical recommendation from professional bodies, not a controlled trial of the rule itself.' },
  yackle2017: { type: 'study', authors: 'Yackle K, Schwartz LA, Kam K, et al.', year: 2017, title: 'Breathing control center neurons that promote arousal in mice', venue: 'Science 355:1411–1415', doi: '10.1126/science.aai7984', note: 'A mechanism study in mice — it explains the plumbing, not a human outcome.' },
  balban2023: { type: 'study', authors: 'Balban MY, Neri E, Kogon MM, et al.', year: 2023, title: 'Brief structured respiration practices enhance mood and reduce physiological arousal', venue: 'Cell Reports Medicine 4:100895', doi: '10.1016/j.xcrm.2022.100895', note: 'One randomized trial over one month; effects were modest.' },
  berman2008: { type: 'study', authors: 'Berman MG, Jonides J, Kaplan S', year: 2008, title: 'The cognitive benefits of interacting with nature', venue: 'Psychological Science 19:1207–1212', doi: '10.1111/j.1467-9280.2008.02225.x', note: 'Two lab experiments.' },
  lee2015: { type: 'study', authors: 'Lee KE, Williams KJH, Sargent LD, Williams NSG, Johnson KA', year: 2015, title: '40-second green roof views sustain attention: The role of micro-breaks in attention restoration', venue: 'Journal of Environmental Psychology 42:182–189', doi: '10.1016/j.jenvp.2015.04.003', note: 'Single lab study.' },
  ulrich1984: { type: 'study', authors: 'Ulrich RS', year: 1984, title: 'View through a window may influence recovery from surgery', venue: 'Science 224:420–421', doi: '10.1126/science.6143402', note: 'A retrospective study of hospital records.' },
  steel2007: { type: 'meta', authors: 'Steel P', year: 2007, title: 'The nature of procrastination: A meta-analytic and theoretical review of quintessential self-regulatory failure', venue: 'Psychological Bulletin 133:65–94', doi: '10.1037/0033-2909.133.1.65' },
  leroy2009: { type: 'study', authors: 'Leroy S', year: 2009, title: 'Why is it so hard to do my work? The challenge of attention residue when switching between work tasks', venue: 'Organizational Behavior and Human Decision Processes 109:168–181', doi: '10.1016/j.obhdp.2009.04.002', note: 'Lab experiments.' },
  rubinstein2001: { type: 'study', authors: 'Rubinstein JS, Meyer DE, Evans JE', year: 2001, title: 'Executive control of cognitive processes in task switching', venue: 'Journal of Experimental Psychology: Human Perception and Performance 27:763–797', doi: '10.1037/0096-1523.27.4.763' },
  parkinson1955: { type: 'essay', authors: 'Parkinson CN', year: 1955, title: "Parkinson's Law", venue: 'The Economist', note: 'A satirical essay, not a study. It is quoted as an observation, not as evidence.' },
  drake2013: { type: 'study', authors: 'Drake C, Roehrs T, Shambroom J, Roth T', year: 2013, title: 'Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed', venue: 'Journal of Clinical Sleep Medicine 9:1195–1200', doi: '10.5664/jcsm.3170', note: 'A small controlled study using a 400 mg dose.' },
  barkley1997: { type: 'review', authors: 'Barkley RA', year: 1997, title: 'Behavioral inhibition, sustained attention, and executive functions: Constructing a unifying theory of ADHD', venue: 'Psychological Bulletin 121:65–94', doi: '10.1037/0033-2909.121.1.65', note: 'A theoretical review.' },
  vandongen2003: { type: 'study', authors: 'Van Dongen HPA, Maislin G, Mullington JM, Dinges DF', year: 2003, title: 'The cumulative cost of additional wakefulness: Dose-response effects on neurobehavioral functions and sleep physiology from chronic sleep restriction and total sleep deprivation', venue: 'Sleep 26:117–126', doi: '10.1093/sleep/26.2.117', note: 'A controlled laboratory study over two weeks.' },
  xie2013: { type: 'study', authors: 'Xie L, Kang H, Xu Q, et al.', year: 2013, title: 'Sleep drives metabolite clearance from the adult brain', venue: 'Science 342:373–377', doi: '10.1126/science.1241224', note: 'A mechanism study in mice.' },
  yoo2007: { type: 'study', authors: 'Yoo S-S, Gujar N, Hu P, Jolesz FA, Walker MP', year: 2007, title: 'The human emotional brain without sleep — a prefrontal amygdala disconnect', venue: 'Current Biology 17:R877–R878', doi: '10.1016/j.cub.2007.08.007', note: 'A small brain-imaging study.' },
  gollwitzer1999: { type: 'review', authors: 'Gollwitzer PM', year: 1999, title: 'Implementation intentions: Strong effects of simple plans', venue: 'American Psychologist 54:493–503', doi: '10.1037/0003-066x.54.7.493' },
  gollwitzer2006: { type: 'meta', authors: 'Gollwitzer PM, Sheeran P', year: 2006, title: 'Implementation intentions and goal achievement: A meta-analysis of effects and processes', venue: 'Advances in Experimental Social Psychology 38:69–119', doi: '10.1016/s0065-2601(06)38002-1' },
  lally2010: { type: 'study', authors: 'Lally P, van Jaarsveld CHM, Potts HWW, Wardle J', year: 2010, title: 'How are habits formed: Modelling habit formation in the real world', venue: 'European Journal of Social Psychology 40:998–1009', doi: '10.1002/ejsp.674', n: 96, note: 'A single study of 96 volunteers over 12 weeks. The widely quoted "66 days" is an average; individual times varied widely.' },
  milkman2014: { type: 'study', authors: 'Milkman KL, Minson JA, Volpp KGM', year: 2014, title: 'Holding the Hunger Games hostage at the gym: An evaluation of temptation bundling', venue: 'Management Science 60:283–299', doi: '10.1287/mnsc.2013.1784', note: 'A field experiment.' },
  mark2008: { type: 'study', authors: 'Mark G, Gudith D, Klocke U', year: 2008, title: 'The cost of interrupted work: More speed and stress', venue: 'Proceedings of CHI 2008:107–110', doi: '10.1145/1357054.1357072', note: 'A lab study.' },
  ward2017: { type: 'study', authors: 'Ward AF, Duke K, Gneezy A, Bos MW', year: 2017, title: "Brain drain: The mere presence of one's own smartphone reduces available cognitive capacity", venue: 'Journal of the Association for Consumer Research 2:140–154', doi: '10.1086/691462', note: 'Lab experiments.' },
  kushlev2015: { type: 'study', authors: 'Kushlev K, Dunn EW', year: 2015, title: 'Checking email less frequently reduces stress', venue: 'Computers in Human Behavior 43:220–228', doi: '10.1016/j.chb.2014.11.005', note: 'A one-week within-person field study.' },
  hedge_ergonomics: { type: 'guidance', authors: 'Hedge A (Cornell University Ergonomics Web)', year: null, title: 'Workstation ergonomics guidelines', venue: 'Professional guidance', note: 'Applied ergonomics guidance, not a trial of the setup described.' },
  rauscher1993: { type: 'study', authors: 'Rauscher FH, Shaw GL, Ky KN', year: 1993, title: 'Music and spatial task performance', venue: 'Nature 365:611', doi: '10.1038/365611a0', note: 'A small study of college students. The effect did not hold up — see Pietschnig et al. (2010).' },
  pietschnig2010: { type: 'meta', authors: 'Pietschnig J, Voracek M, Formann AK', year: 2010, title: 'Mozart effect–Shmozart effect: A meta-analysis', venue: 'Intelligence 38:314–323', doi: '10.1016/j.intell.2010.03.001', note: 'The meta-analysis that found little to no specific "Mozart effect". Included because the ledger must carry the replication, not just the headline.' },
  mehta2012: { type: 'study', authors: 'Mehta R, Zhu R, Cheema A', year: 2012, title: 'Is noise always bad? Exploring the effects of ambient noise on creative cognition', venue: 'Journal of Consumer Research 39:784–799', doi: '10.1086/665048', note: 'Lab studies; the effect was specific to creative tasks, not precision work.' },
  masicampo2011: { type: 'study', authors: 'Masicampo EJ, Baumeister RF', year: 2011, title: 'Consider it done! Plan making can eliminate the cognitive effects of unfulfilled goals', venue: 'Journal of Personality and Social Psychology 101:667–683', doi: '10.1037/a0024192', note: 'Lab experiments.' },
  allen2001: { type: 'book', authors: 'Allen D', year: 2001, title: 'Getting Things Done: The Art of Stress-Free Productivity', venue: 'Viking', note: 'A practitioner method, not a study.' },
  zaccaro2018: { type: 'review', authors: 'Zaccaro A, Piarulli A, Laurino M, et al.', year: 2018, title: 'How breath-control can change your life: A systematic review on psycho-physiological correlates of slow breathing', venue: 'Frontiers in Human Neuroscience 12:353', doi: '10.3389/fnhum.2018.00353', note: 'A systematic review.' },
  lehrer2014: { type: 'review', authors: 'Lehrer PM, Gevirtz R', year: 2014, title: 'Heart rate variability biofeedback: How and why does it work?', venue: 'Frontiers in Psychology 5:756', doi: '10.3389/fpsyg.2014.00756', note: 'A review.' },
  hillman2008: { type: 'review', authors: 'Hillman CH, Erickson KI, Kramer AF', year: 2008, title: 'Be smart, exercise your heart: Exercise effects on brain and cognition', venue: 'Nature Reviews Neuroscience 9:58–65', doi: '10.1038/nrn2298', note: 'A review.' },
  oppezzo2014: { type: 'study', authors: 'Oppezzo M, Schwartz DL', year: 2014, title: 'Give your ideas some legs: The positive effect of walking on creative thinking', venue: 'Journal of Experimental Psychology: Learning, Memory, and Cognition 40:1142–1152', doi: '10.1037/a0036577', note: 'A series of lab experiments.' },
  goyal2014: { type: 'meta', authors: 'Goyal M, Singh S, Sibinga EMS, et al.', year: 2014, title: 'Meditation programs for psychological stress and well-being: A systematic review and meta-analysis', venue: 'JAMA Internal Medicine 174:357–368', doi: '10.1001/jamainternmed.2013.13018', note: 'The review graded the evidence for attention benefits as low or insufficient.' },
  killingsworth2010: { type: 'study', authors: 'Killingsworth MA, Gilbert DT', year: 2010, title: 'A wandering mind is an unhappy mind', venue: 'Science 330:932', doi: '10.1126/science.1192439', note: 'A large experience-sampling study; correlational.' },
  lutz2008: { type: 'review', authors: 'Lutz A, Slagter HA, Dunne JD, Davidson RJ', year: 2008, title: 'Attention regulation and monitoring in meditation', venue: 'Trends in Cognitive Sciences 12:163–169', doi: '10.1016/j.tics.2008.01.005' },
  mrazek2013: { type: 'study', authors: 'Mrazek MD, Franklin MS, Phillips DT, Baird B, Schooler JW', year: 2013, title: 'Mindfulness training improves working memory capacity and GRE performance while reducing mind wandering', venue: 'Psychological Science 24:776–781', doi: '10.1177/0956797612459659', note: 'A single randomized study of undergraduates.' },
  zeidan2010: { type: 'study', authors: 'Zeidan F, Johnson SK, Diamond BJ, David Z, Goolkasian P', year: 2010, title: 'Mindfulness meditation improves cognition: Evidence of brief mental training', venue: 'Consciousness and Cognition 19:597–605', doi: '10.1016/j.concog.2010.03.014', note: 'Brief training, small sample.' },
  brewer2011: { type: 'study', authors: 'Brewer JA, Worhunsky PD, Gray JR, Tang Y-Y, Weber J, Kober H', year: 2011, title: 'Meditation experience is associated with differences in default mode network activity and connectivity', venue: 'PNAS 108:20254–20259', doi: '10.1073/pnas.1112029108', note: 'A small brain-imaging study of experienced meditators; correlational.' },
  tang2015: { type: 'review', authors: 'Tang Y-Y, Hölzel BK, Posner MI', year: 2015, title: 'The neuroscience of mindfulness meditation', venue: 'Nature Reviews Neuroscience 16:213–225', doi: '10.1038/nrn3916', note: 'The authors note that many studies are small or poorly controlled.' },
  cirillo2006: { type: 'book', authors: 'Cirillo F', year: 2006, title: 'The Pomodoro Technique', venue: 'Self-published; later Currency (2018)', note: 'The method itself, not evidence for it.' },
  schultz1997: { type: 'study', authors: 'Schultz W, Dayan P, Montague PR', year: 1997, title: 'A neural substrate of prediction and reward', venue: 'Science 275:1593–1599', doi: '10.1126/science.275.5306.1593', note: 'Primate electrophysiology — a mechanism, not a productivity finding.' },
  lembke2021: { type: 'book', authors: 'Lembke A', year: 2021, title: 'Dopamine Nation: Finding Balance in the Age of Indulgence', venue: 'Dutton', note: 'A clinician\'s book, not a study.' },
  csikszentmihalyi1990: { type: 'book', authors: 'Csikszentmihalyi M', year: 1990, title: 'Flow: The Psychology of Optimal Experience', venue: 'Harper & Row', note: 'The originating account of flow; largely descriptive.' },
});

/** The link for a source: its DOI when verified; a verified URL for guidance; otherwise nothing. */
export function sourceUrl(src) {
  if (!src) return null;
  if (src.doi) return doi(src.doi);
  if (src.type === 'guidance' && src.url) return src.url;
  return null;
}
