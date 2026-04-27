# Essay workbook — *Counter-Rendering TikTok*

A free-write workbook for the accompanying essay. Structure: ten pages, roughly 400 words each, around 4,000 words total. The personal argument sits alongside the technical argument because the project IS both of those things. Don't apologise for the depth.

**How to use each page:**

1. **What this page argues** — one sentence. The job the page has to do.
2. **Source material** — every fact, number, quote, formula, or citation you might reference. No hunting.
3. **Deep prompts** — open-ended questions. They are designed to resist easy answers. Free-write past them. The goal is *your* interpretation, not a correct answer.
4. **Write here** — the block you fill.

Placeholders in `[brackets]` are the numbers to fill in from your tool. Replace as you write.

---

# PART I — The personal argument

## Page 1 — Opening and frame

**What this page argues.** This essay is not a description of surveillance capitalism in the abstract. It is a reading of one archive against the theoretical frame Zuboff established, executed with open-source tools this author built. The essay's method is its argument.

### Source material

- **Zuboff quote** (use as the opening block quote):
  > "Surveillance capitalism's technologies are designed to render our experience into data, as in rendering oil from fat, typically outside of our awareness, let alone our consent."
  — Shoshana Zuboff, *The Age of Surveillance Capitalism* (2019), introduction.

- **What the tool does, in three clauses.** It parses a TikTok data export locally in the browser. It runs a deterministic feature-extraction pipeline over every row. It fits a first-order Markov chain on the session-level trace to test predictability. All methods are documented, versioned, and bit-for-bit reproducible.

- **Three contract sentences** for the reader:
  1. Every number in the essay came from the author's own TikTok archive, processed with the accompanying tool.
  2. Every method is open source and cited. See writeup.pdf §2 and §10.
  3. The essay does not attempt to recover TikTok's actual ranker. It argues about structural shape.

### Deep prompts

- **Prompt 1.** Zuboff's metaphor for rendering is industrial: oil is rendered from fat by applying heat. What is the equivalent operation in the data case? What is "heat" here, and what is "fat"? Do not settle for the obvious answer. Push on it.

- **Prompt 2.** Why is building a tool the right methodological move for this essay? An alternative would have been a close-reading of Zuboff plus screenshots of the TikTok settings page. Argue for the choice you made.

- **Prompt 3.** Name what the essay is NOT doing. This is the single most important paragraph in the intro because it pre-empts the honest objection a reader will raise.

**Your page 1 here:**

> (free write)

---

## Page 2 — Capture, part I: what rendering actually is

**What this page argues.** Rendering is filtering. Raw behaviour is continuous, ambiguous, embodied. Signals are discrete, typed, stripped of context. Step 1 makes that difference visible at the scale of a whole archive.

### Source material

- **Definition of "signal" used throughout the essay.** A named, typed, bounded field a learning system can read without further interpretation.

- **Your archive at a glance** (from the tool's Step 1 sub-step 1):
  - Total events: `[X]`
  - Events with user-typed text: `[X]` (`[Y]%`)
  - Of those, events with at least one sentiment-lexicon hit: `[X]` (`[Y]%`)
  - Events carrying a raw payload: `[X]`

- **Hal Varian quote** (cited through Zuboff 2019):
  > "Every action a user performs is considered a signal to be analyzed and fed back into the system."

- **Useful historical contrast.** In the early web, user data was reinvested in the same service (better spellcheck, faster search). Zuboff calls this the *behavioural value reinvestment cycle*. The shift she names is when the predictions produced from that data became the product, not the service.

### Deep prompts

- **Prompt 1.** Raw behaviour is infinite-dimensional. A signal is finite-dimensional. What is lost in the projection? Do not just list things that aren't stored; argue that the loss is not incidental, that it is the definition of the operation.

- **Prompt 2.** Write the four archive-level numbers, then interpret them. Which ratio surprised you? Which did not? Does your surprise tell you something about your prior beliefs about what TikTok collects?

- **Prompt 3.** Varian's quote treats "signal" as obviously good. Zuboff treats it as obviously fraught. Between those two positions, where does your argument sit? Do not pick the easy middle.

**Your page 2 here:**

> (free write)

---

## Page 3 — Capture, part II: one moment pulled apart

**What this page argues.** The archive-level view is too abstract to make the argument land. One specific row, walked through in detail, shows rendering happening at a scale the reader can feel.

### Source material

- **Your lived moment** (block quote it):
  > `[it would be so awesome it would be so cool]`
  > Dec 24, 2025, 10:59 PM · intent event · TikTok/Your Activity/Searches.txt

- **Why this row.** The tool picks the row with the richest natural-language content. It is the strongest single example in the archive for watching the classifier do something visible. Every other row goes through the same pipeline.

- **Fate breakdown from the tool** (the carousel groups):
  - Never stored (red): `[N]` dimensions. Examples your row lost: your reason for typing it, your mood, your physical surroundings, what you were doing right before.
  - Kept word for word (green): `[N]` dimensions. Examples: the text string, the timestamp, the source file path.
  - Turned into a number (amber): `[N]` dimensions. Example: sentiment score.
  - Inferred from nearby rows (sky): `[N]` dimensions. Example: session membership.

- **The row's raw record** (the tool also shows the actual JSON-ish payload TikTok stored). Include this only if you want to ground the abstract "row" in the concrete export.

### Deep prompts

- **Prompt 1.** Quote the lived moment verbatim at the top of the page. Do not paraphrase. Treat it as a primary source. Then, in one short paragraph, describe what it felt like to type it. Not what it meant. What it felt like to type.

- **Prompt 2.** Walk the four fate categories. For each, pick the single most interesting item. Not the list — one each. Argue for your pick.

- **Prompt 3.** The Never-Stored group is where Zuboff's "reduction" lives. Your reason, your mood, your environment. Argue that the absence of these fields is not neutral; argue that the model cannot be trusted to make claims about you on their basis precisely because they are the context that would have explained the action.

**Your page 3 here:**

> (free write)

---

## Page 4 — Capture, part III: the flattening step in detail

**What this page argues.** The sentiment classifier is the one place in the essay where you watch an ML model perform rendering. Your words go in. A single number comes out. This is the operation, in miniature.

### Source material

- **The formula** (from writeup.pdf §2.3, `sentiment.ts`):

  `score(w_i) = (−1)^(1[w_i negated]) · I_{i−1} · L(w_i)`
  `normalised = Σ_i score(w_i) / √(N_words)`

  Where **L** is an AFINN-subset lexicon mapping about 150 English words to integer valences in [−5, +5]. **I_{i−1}** is an intensifier multiplier from the previous token (e.g., "very", "really" → 1.5). The negation exponent is 1 if a negator ("not", "never", "no") appears within two tokens before **w_i**, else 0. The √N_words normalisation keeps short emotional phrases comparable to longer neutral ones.

- **Applied to your row** (fill from the tool):
  - Matched tokens and their **L** values: `[list]`
  - Raw score: `[X]`
  - Word count N: `[X]`
  - Normalised score: `[X]`
  - Label: `[positive / neutral / negative]`

- **Why a lexicon, not a transformer.** A transformer would be more accurate and less transparent. Every weight in a transformer is learned, opaque, and non-reproducible across seeds. A lexicon's "weights" are a table of 150 English words with human-assigned valences you can inspect in full. The essay's point is auditability, not accuracy.

- **What the classifier does not see.** Sarcasm. Context. Tone. Cultural reference. Whatever made you type this specific set of words at this specific moment. None of it survives.

### Deep prompts

- **Prompt 1.** Write the formula. Then translate every symbol into plain English, in sequence. Not as a gloss — as a claim. Each symbol is a design choice. Why does L exist? Why does I_{i−1} exist? Why is the exponent on (−1) a boolean? Why the square root?

- **Prompt 2.** Apply the formula to your row step by step. Show the intermediate scores. Make the reader see the arithmetic.

- **Prompt 3.** Argue that flattening, not collection, is the operative step in Zuboff's rendering. The data being stored is one thing. The data being compressed to a feature a policy can consume is a different thing. Which one does the surveillance-capitalist business model actually need?

- **Prompt 4.** What would a transformer do here that a lexicon cannot? Name the accuracy gain and the accountability cost. Argue for your choice.

**Your page 4 here:**

> (free write)

---

# PART II — The model and the loop

## Page 5 — Prediction: how compressible you are

**What this page argues.** Given your past as training data, a first-order Markov chain predicts your next move with specific accuracy on your own future. The accuracy is a measurement of how compressible you are, and compressibility is the commodity.

### Source material

- **The model in one line.** A first-order Markov chain over a finite state space is the simplest useful sequence model: the distribution over the next state depends only on the current state. Parameters are counts.

- **MLE and Laplace smoothing** (from writeup.pdf §2.4):

  `P̂_MLE(a|s) = n(s, a) / n(s)`
  `P̂_Laplace(a|s) = (n(s, a) + α) / (n(s) + αK)`

  With α = 1 and K = number of observed states. The MLE form is used for the UI transition table (so a reader can reproduce it by counting). The smoothed form is used only for entropy computation, where zero-probability cells would otherwise blow up log₂.

- **Your numbers** (from Step 2 sub-step 2 of the tool):
  - Held-out top-1 accuracy: `[X]%` (95% bootstrap CI `[L]–[H]%`), on `[N]` held-out bigrams.
  - In-sample accuracy: `[X]%`; fit–gen gap `[Δ]` pp.
  - Mean policy entropy: `[H]` bits; perplexity = `2^H` = `[P]` vs. uniform baseline `log₂K = [X]` for K = `[5]`.
  - Strongest rule: "After `[state A]` you `[state B]`" at `[P]%` over `[N]` observations; held-out calibration `[P']%` (Wilson 95% CI).

- **Why chronological 80/20, not random.** A random split leaks future information into training (the model would see some of the future during fit). Chronological asks the honest question: can a model built from your past predict your future? Writeup §2.6.

### Deep prompts

- **Prompt 1.** A first-order Markov is arguably the simplest useful sequence model. That it hits `[X]%` held-out accuracy on your trace tells you what, exactly? Make the claim sharp. A more sophisticated model could do better. How much more? What does the room between `[X]%` and 100% mean for how much headroom a production recommender has?

- **Prompt 2.** Perplexity of `[P]` against a uniform baseline of `[K]` says the model behaves as if choosing between roughly `[P]` real options per move instead of `[K]`. That is a compression ratio. Argue that Zuboff's "behavioural surplus" is, concretely, this ratio.

- **Prompt 3.** The strongest rule fires `[P]%` of the time. Walk through what a recommender does with that rule at platform scale. One field in, one prediction out, one ranking choice. The mechanical chain. Do it concretely using your top rule.

- **Prompt 4.** The chronological split answers "can past-me predict future-me?" This is a different question from "can this model predict users in general?" Zuboff's argument is population-scale. What does a within-user generalisation test give the argument? What does it miss?

**Your page 5 here:**

> (free write)

---

# PART III — The technical backend

## Page 6 — How the tool actually works: methodology in detail

**What this page argues.** The tool's commitments — deterministic, auditable, per-row, versioned — are not just engineering virtues. They are the conditions under which the essay's claims can be checked. Opacity would be incompatible with the argument.

### Source material

- **The row inference pipeline** (writeup.pdf §5.1, `src/lib/tiktok/infer.ts`). For each event, `inferRow` produces:
  - A plain-language rendering sentence.
  - A surplus verdict: `likely_surplus | mixed | unclear`.
  - A set of signal types detected (regex-based, e.g. `text_query_intent_signals`).
  - Four 0–100 scores: surplus, signal richness, identity linkage, data quality.
  - A five-tier confidence classification.
  - Evidence strings: which substrings triggered each signal match.

- **Scoring is feature-based, not learned.** Weights and thresholds are in-module constants. `INFERENCE_MODEL_VERSION` and `FEATURE_EXTRACTION_RULESET_VERSION` are string exports that snapshot into every JSON report. Given the same archive and the same version strings, the output is bit-for-bit reproducible.

- **The Markov pipeline** (writeup.pdf §6, `rlTrace.ts`):
  1. Filter events to those with parseable ISO timestamps.
  2. Sort chronologically.
  3. Walk consecutive pairs; drop any pair with a gap > `SESSION_GAP_MINUTES = 30`. Cross-session transitions are semantically different and handled by a separate `loops.ts` module.
  4. Emit each kept pair as a `Bigram{from, to, reward}`, where reward is the density count of the target event.

- **Statistical primitives used:**
  - **Wilson 95% CI** (writeup §2.7) for every transition probability. Inverts the score test; always lies in [0, 1]; handles `p̂` near 0 or 1 where Wald breaks.
    `centre = (k + z²/2) / (n + z²)`
    `half = z·√(k(n−k)/n + z²/4) / (n + z²)`
    with z = 1.96.
  - **Percentile bootstrap** (writeup §2.8) for accuracy CIs. Resample the eval set B = 200 times with replacement; recompute accuracy each time; take the 2.5% and 97.5% quantiles. Policy held fixed, so this captures evaluation-sample variance but *not* refit variance.
  - **Shannon entropy and perplexity** (writeup §2.5): `H = −Σ p̂·log₂(p̂)`, visit-weighted across states; `perplexity = 2^H`.
  - **Per-state held-out calibration.** Aggregate accuracy can mask a single miscalibrated rule that shows up in many predictions. For each state, compute train-fit vs. test-observed rates separately.

- **A political claim about model versioning.** Every ML-touching module exports `MODEL_VERSION` (see writeup §2.10 for the list). These get embedded in every JSON report. The claim is not just technical reproducibility; it is that auditability is a precondition for the essay's critique to be intellectually honest.

### Deep prompts

- **Prompt 1.** Walk through `inferRow` in your own words. The four scores, what each measures, what they can and cannot tell you about a row. Emphasize that this is a design choice: a learned classifier would produce the same four scores with higher accuracy and zero explainability.

- **Prompt 2.** Justify the choice of Wilson CIs over Wald. Why is the standard choice wrong here? What does that tell you about default statistical practice in engagement-metrics dashboards you have seen?

- **Prompt 3.** The bootstrap CI captures evaluation variance, not refit variance. Why does that matter? A reader could honestly object: if you re-fit the model on each bootstrap sample, the CI would be wider. Concede the point. Explain why the choice was made anyway.

- **Prompt 4.** The MODEL_VERSION string is seven ASCII characters in a JSON field. Argue that it is doing political work, not just engineering work. Writeup §2.10 sets this up; you are asked to extend it.

**Your page 6 here:**

> (free write)

---

## Page 7 — Loop: prediction becomes policy

**What this page argues.** A prediction is not inert. Once accurate, the prediction *is* the policy. The feed chooses what best matches the predicted next state. That choice produces new behaviour, which becomes new training data. The loop tightens.

### Source material

- **The three harms** (writeup.pdf §8), bounded to observables from your trace. Do not reorder. Do not invent.

  1. **Polarization — "rails in your feed"**
     - Strongest-transition probability: `[P]%`
     - Returning-interest rate: `[R]%`
     - Mechanism: when one move has near-deterministic exit probability, serving content that keeps the user on that rail maximises expected reward. More exposure → more observations → higher confidence → more exposure.

  2. **Compulsion — "the cadence of your return"**
     - Median gap between sessions: `[H]` hours
     - Sessions per week implied: `[7·24/H] ≈ [N]`
     - Mechanism: the cue → action → reward triple is the literal training loop for habit-forming agents in the RL literature. Return cadence is how the model measures which cues landed.

  3. **Emotional targeting — "your words flattened to a number"**
     - Sentiment score of your showcase row: `[+1.64]`
     - Mechanism: once the scalar is extracted, the model compares it to candidate videos' sentiment scores and matches. Your vocabulary, your concepts, your reason for the mood — discarded. What persists is the number.

- **Your top search-to-watch cascade** (from `loops.ts`, Search → Watch carousel):
  | Search term | Follow-up watches |
  |---|---|
  | `[qur'an recitation]` | `[1743]` |
  | `[Dua for thunder]` | `[1742]` |
  | `[Quran mushaf]` | `[1733]` |
  | `[Fav mushaf]` | `[1732]` |
  | `[best mushaf for hifz]` | `[N]` |

- **The mechanism of a cascade.** Typing the query triggered a predict-and-match round. Each follow-up watch became a new labelled training example (query → watched item). The rule refined itself in near-real time. The "rabbit hole" is not a failure mode; it is the loop converging on a local optimum where your next move has near-zero entropy.

### Deep prompts

- **Prompt 1.** The move from prediction to policy is the Zuboffian turn. Before: the data improves the service. After: the predictions ARE the service. Write this turn concretely, using your numbers. At what accuracy does prediction become policy? Is there a threshold, or is it a gradient?

- **Prompt 2.** Take the three harms one at a time. For each: name the mechanism, cite your number, then name what the number does NOT show. The asymmetry between what an observable can claim and what a reader will read into it is the whole game.

- **Prompt 3.** Walk the top cascade. Do not just report the number. Explain why it is so large. What does it mean that one query produced `[1743]` labelled training examples in one session? What is the information-theoretic interpretation of that number?

- **Prompt 4.** The cascade pattern looks like a rabbit hole from the user's side and a successful inference from the system's side. Argue that these are the same event described with different vocabularies. Which vocabulary is doing the work in most public discourse about algorithmic feeds?

**Your page 7 here:**

> (free write)

---

## Page 8 — Connections to production ML

**What this page argues.** The tool's first-order Markov is the simplest working version of a family of models that production recommenders have been refining for fifteen years. Naming the connections is how the essay earns the right to make scale claims.

### Source material

- **What the tool uses:**
  - Per-row regex feature extraction → four scalar scores.
  - Lexicon-based sentiment classifier.
  - First-order Markov chain with add-1 Laplace smoothing.
  - Argmax policy derived from the train-fit chain.

- **What production recommenders actually use** (not secret, all published):
  - **Deep learning ranking models.** Google's DLRM (Naumov et al. 2019) and YouTube's deep neural net ranker (Covington et al. 2016) predict click/watch probability from high-dimensional embeddings of items and users.
  - **Two-tower architectures.** Encode user state in one tower, item features in another, take dot product. Underlies LinkedIn, YouTube, Pinterest recommenders.
  - **Sequential recommendation transformers.** BERT4Rec (Sun et al. 2019), SASRec (Kang & McAuley 2018). Treat a user's history as a sequence, apply attention to predict next item. Higher-order analogue of the first-order Markov.
  - **Off-policy reinforcement learning.** Chen et al. (2019), *Top-K Off-Policy Correction for a REINFORCE Recommender System*, the YouTube paper. Handles the fact that the system selected the candidate the user saw, so naive observational data is biased. Writeup §11 flags this as the next honest step.
  - **Learned embeddings for state.** Instead of discrete categorical primitives (attention / preference / intent / …), modern systems learn continuous vector representations that capture user state with hundreds of dimensions.

- **The connection to RLHF.** In reinforcement learning from human feedback (Christiano et al. 2017, Ouyang et al. 2022 for InstructGPT), a reward model takes text and outputs a scalar. That scalar is then used to shape the policy. Structurally, this is identical to your sentiment step feeding a feed-ranking policy. The RLHF reward model is more accurate than a lexicon; the operation is the same shape.

- **The connection to compression and prediction.** Information-theoretically, a good predictor is a good compressor (Solomonoff; Hutter). Your Markov's perplexity of `[P]` vs. uniform `[K]` means the model compresses your next move from `log₂K` bits to `H` bits. This is the formal statement of "behavioural surplus."

### Deep prompts

- **Prompt 1.** Your first-order Markov is a "degenerate MDP" with observable discrete states. A production system uses learned embeddings and off-policy RL. Argue that the shape of the argument — rendering → prediction → policy — does not change, only the precision does. Where does the argument break down, if anywhere?

- **Prompt 2.** RLHF reward models and your sentiment step perform the same operation (text → scalar → policy weight). Is this an analogy, a metaphor, or a structural identity? Argue the strongest version of the identity claim. What does it mean for the ethics of deployment that the same pattern shows up in both consumer feeds and "aligned" language models?

- **Prompt 3.** Compression = prediction is a well-established information-theoretic result. Your perplexity number is a compression ratio. Rewrite one of Zuboff's claims about "behavioural surplus" using the language of compression. Does the translation preserve the argument?

- **Prompt 4.** The gap between what your tool does and what a production system does is mostly a gap in expressiveness: categorical states vs. learned embeddings, first-order vs. transformer, observational vs. off-policy corrected. Which of these gaps would change the essay's argument if closed? Which would not?

**Your page 8 here:**

> (free write)

---

## Page 9 — Limitations

**What this page argues.** The tool's limits are named because naming them is a condition of the critique's honesty. Readers who raise these objections are raising the right ones.

### Source material

- **Structural limits (from writeup.pdf §8, elaborated):**

  1. **First-order Markov misses higher-order structure.** The model assumes the next state depends only on the current state. In reality your sessions have longer-range dependencies (Session start ≠ Session middle). A second-order or LSTM-style model would capture them. Quantitatively this would raise held-out accuracy by a known margin in comparable work (Kang & McAuley 2018 show ~10–20pp gain from transformer-vs-Markov on Amazon sequences).

  2. **Within-trace density is a proxy, not an external engagement signal.** The tool's `reward` is density count of the target event. This measures co-occurrence, not engagement. It cannot validate the direction of causation. The observational nature of the data means all predictions are confounded by the fact that the system selected what you saw.

  3. **Categorical state space is coarse.** Six event primitives (attention / preference / intent / social / account / unknown) is deliberately a simplification. A production model uses a hundred-dimensional learned embedding that captures content topics, creator identity, prior engagement, and hundreds of other fields. Any claim about "what the model knows" is an underestimate.

- **Scale and sample limits:**

  4. **Single-user, n=1.** The archive is the author's. For any population-scale claim (e.g., about surveillance capitalism in general), this is a case study, not evidence. The tool is reproducible on any user's export.

  5. **Lexicon-based sentiment is English-only and narrow.** ~150 words, AFINN-subset, no multi-word phrases or idioms. Non-English text is invisible. A transformer classifier would do much better at the cost of auditability.

- **Statistical limits:**

  6. **Bootstrap captures evaluation variance, not refit variance.** Re-fitting on each resample would yield wider, more honest CIs at ~20× the compute. The current CIs understate uncertainty.

  7. **Effective sample size is not corrected.** Within-session bigrams are not iid. Dividing n by the autocorrelation lag would give a more honest denominator for every Wilson CI in the tool.

  8. **No permutation baseline on entropy reduction.** The observed reduction from uniform to `[H]` bits has no p-value attached. Shuffling the bigram stream B times and recomputing mean entropy would give the fraction of shuffles with equal or greater reduction. That is the honest significance test.

- **Epistemic limit:**

  9. **The tool infers what a model *could* do, not what TikTok *is* doing.** Every claim in the essay is modal (could, would, might) rather than indicative (is, does). This is not hedging. It is the tool's actual epistemic status.

### Deep prompts

- **Prompt 1.** Pick the three limits you think matter most for the essay's argument. Not the three most technically severe — the three that most threaten the argument's intellectual integrity if left unaddressed. Argue for your picks.

- **Prompt 2.** The observational nature of the data means every transition you measure is confounded by the fact that the system chose what you saw. Off-policy correction exists for exactly this problem. Why did the tool not implement it? Is that a pragmatic limit or a principled one?

- **Prompt 3.** The n=1 problem. The essay is about you. Zuboff's argument is about the population. Where does the bridge between single-case and population-scale sit, and what load can it bear?

- **Prompt 4.** An honest reader could object: "You built the simplest possible version of each thing and then drew the strongest possible conclusions." Defend against that objection. Do not minimise it.

**Your page 9 here:**

> (free write)

---

## Page 10 — Future work and conclusion

**What this page argues.** The obvious next steps are known and small. The essay's closing move returns to Zuboff and names what this specific exercise accomplished that prose alone could not.

### Source material

- **Future work** (from writeup.pdf §11, pick three to develop):

  1. **Walk-forward k-fold cross-validation.** Replace the single 80/20 split with k-fold walk-forward CV. Report mean ± stddev on accuracy.

  2. **Higher-order Markov with AIC/BIC.** Fit n = 1, 2, 3 chains; select by information criterion. Answers empirically whether longer context helps for *this* user.

  3. **Permutation baseline for entropy reduction.** Shuffle the bigram stream B times. Report the p-value on entropy reduction below uniform. Gives the first honest significance test in the tool.

  4. **Reliability diagram + Brier score.** Bucket predictions by stated probability; plot actual vs. predicted rate. Exposes per-bucket miscalibration that point-estimate + Wilson CI cannot catch.

  5. **Effective sample size correction.** Within-session bigrams are autocorrelated. Dividing by lag gives honest denominators in every CI.

  6. **Topic modelling (LDA) on search/comment text.** Produces a second, more informative ML rendering step: text → distribution over topics. Polarization could then be shown as drift in a topic simplex over time, a richer picture than the current single-number "strongest rule."

  7. **Off-policy correction (Chen et al. 2019).** The principled fix for the observational-RL confound. Would let the tool make stronger causal claims about which transitions are user-driven vs. system-driven.

  8. **Schema-level data-quality dashboard.** Per-source-file null rates, per-field coverage, event counts dropped at each parse stage. Fleshes out the current `dataQuality` snapshot.

- **Closing material for the conclusion:**

  - The second half of the original Zuboff passage (you can bring it back):
    > "…every time we encounter a digital interface we make our experience available to 'datafication,' thus 'rendering unto surveillance capitalism' its continuous tithe of raw-material supplies."

  - **Counter-rendering as a verb.** Reading an archive slowly — parsing, classifying, computing, visualising — is itself a rendering. But the direction is reversed. The data is taken back out and the operations made visible.

  - **Candidate closing sentences** (use, modify, write your own):
    - "The feed is not made of your content. The feed is made of predictions, and the predictions are made of you."
    - "Rendering is the business. The essay is an act of counter-rendering."
    - "A first-order Markov chain predicts `[X]%` of my next moves from my past. That is not a claim about what TikTok does. It is a statement about what I, as a training set, am."

  - **Final citation.** writeup.pdf §2.10. Every model version, hyperparameter, and formula referenced in the essay is documented there. Reproducibility is not a footnote; it is the condition that makes the critique intelligible.

### Deep prompts

- **Prompt 1.** Of the eight future-work items, pick three. Say in one or two sentences each what implementing it would reveal. Not what it would improve — what it would reveal that the current tool cannot.

- **Prompt 2.** Return to Zuboff's "datafication" sentence. The essay has now walked through that sentence happening on your own archive, in nine pages. Say that directly. Do not hedge.

- **Prompt 3.** Name what counter-rendering accomplishes. It is not deletion. It is not privacy. It is not resistance in the political sense. What it is, is a specific epistemic act: taking a thing that was done to you and making it visible. Argue for the value of that.

- **Prompt 4.** Write your closing sentence. One sentence. No em dashes. No hedging. The thing that, if someone only remembered one line from the essay, you would want them to remember.

**Your page 10 here:**

> (free write)

---

# Process notes

1. **Order to draft in.** Start with pages 3 and 5. They have the most specific material. Then 4, then 7 (because the harm cards are already quite structured). Then 6 and 8 together (technical). Then 9 (limits). Then 2. Then 1 and 10 last, when you know what you wrote.

2. **Write past the prompts.** Every prompt is an invitation, not a constraint. If the paragraph goes somewhere the prompt didn't ask, follow it.

3. **Revise in a second pass.** Commas and periods only. No em dashes. Every sentence either reports a fact, interprets a number, or lands a claim. If a sentence does none of those, cut it.

4. **Paste into the LaTeX scaffold** (`essay-scaffold.tex`) when the prose is tight. The scaffold has the bibliography and section structure. You fill the `\yourwords{...}` blocks.

## Pre-submission checklist

- No em dashes anywhere.
- Every `[bracket]` replaced with a real number from your archive.
- Every claim about what a production system "would" or "could" do is marked modal, not indicative.
- Every citation is a real paper, regulation, or documented feature. No invented sources.
- No claim of the form "TikTok does X." Only claims about your archive's shape, and about what a model of that shape would mechanically be able to do.
- Total word count: 3,800–4,200.

## Word-count check

```bash
wc -w writeup/essay-workbook.md
```

Subtract ~2,400 words for the scaffold material (prompts + source blocks). Your actual written content target is the remainder.

Go.
