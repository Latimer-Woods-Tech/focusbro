# Content rating (IARC questionnaire): answers for net.focusbro.app

Play Console → **Policy and programs → App content → Content rating → Start questionnaire**.
There's no API for this form. These answers were decided by reading the app (the live
site the shell loads, `public/index.html`, `api/src/*`) on 2026-10-03.

**Email address for the rating certificate:** `support@focusbro.net`

## Category

**All Other App Types.** FocusBro is a productivity and follow-through tool: reminders,
a focus timer, ambient sound, breathing. It isn't a game, a social network, news, or
educational reference.

## Questions

| Question (paraphrased; the console wording varies slightly) | Answer | Why |
|---|---|---|
| Violence: does the app contain violent content? | **No** | |
| Fear / horror content? | **No** | |
| Sexuality or nudity? | **No** | |
| Gambling, simulated gambling, or real-money betting? | **No** | |
| Crude humour? | **No** | |
| Profanity or crude language? | **No** | All copy is fixed and first-party. Your own words are visible only to you, and to a coach you invite. |
| References to, or use of, alcohol, tobacco, drugs? | **No** | ⚠️ See note 1 |
| Discrimination / hate? | **No** | |
| **Does the app allow users to interact or exchange content with each other?** | **Yes** | ⚠️ See note 2 |
| Can users share their location with other users? | **No** | No location is collected. A word's timezone is a setting, not a location. |
| Does the app allow purchase of digital goods? | **No** | The app sells nothing and shows no prices. Pro is sold only on the website. |
| Does the app contain unrestricted internet access (a web browser)? | **No** | The webview is limited to `focusbro.net` (`allowNavigation`). Every other host opens in the system browser. |
| Is the app a "news" app? / Does it contain user-generated content that's publicly shared? | **No** | Nothing a person types is ever public. Focus sprints show a **count**, never names. |

Expected result: **Everyone / PEGI 3 / ESRB E** (the coach interaction may add an
"Users Interact" descriptor).

### Notes (decide before you submit)

1. **Medication mention.** The dashboard includes a **Med Reminder** card ("Track your
   medication & dopamine reset times", `public/index.html` ~line 2438). It only logs a
   dose time in local storage, so it's not drug *content*, and **No** is the honest answer
   to the drug question. The card does matter for the Health apps declaration, though
   (see `app-content-checklist.md` §6).
2. **User interaction = Yes** because of the coach link (`api/src/coach.js`): a person can
   accept a coach's invitation, and the coach then sees their kept-word momentum and can
   send them a note. It's opt-in, one-to-one and consent-gated, but it's still
   user-to-user, so IARC wants **Yes**. If the coach feature is hidden in the app
   before launch, change this to **No**.
