/* ÉDITEZ CE FICHIER après vos captures :
 * - file    : nom du fichier dans demo/public/clips/
 * - start   : seconde de la SOURCE où démarrer (trim d'entrée)
 * - seconds : durée affichée dans le montage
 * - rate    : vitesse de lecture (1 = normal, 8 = timelapse pour le build)
 * - caption : légende affichée en bas
 * NB : start + seconds × rate doit rester ≤ durée réelle du fichier. */

export const FPS = 30;

export const CLIPS = [
  {
    file: "clip1.mov",
    start: 0,
    seconds: 27.3,
    rate: 1,
    caption: "The video pauses itself. The tutor asks — out loud. You answer.",
  },
  {
    file: "clip2.mov",
    start: 0,
    seconds: 27,
    rate: 1,
    caption: "Half-right? One targeted follow-up on exactly what you missed — never a loop.",
  },
  {
    file: "clip3.mov",
    start: 0,
    seconds: 30.6,
    rate: 1,
    caption: "Wrong on purpose: it catches you, re-explains differently, offers the exact replay.",
  },
  {
    file: "clip4.mov",
    start: 0,
    seconds: 22.3,
    rate: 1,
    caption: "At the end, a report: score per checkpoint, weak spots first, one click to replay the exact moment.",
  },
];

export const TITLE_SECONDS = 7;
export const END_SECONDS = 7;

/* Durée d'affichage d'une légende avant son fondu de sortie (secondes). */
export const CAPTION_SECONDS = 6;

export const totalFrames = () =>
  Math.round(
    (TITLE_SECONDS + END_SECONDS + CLIPS.reduce((a, c) => a + c.seconds, 0)) * FPS
  );
