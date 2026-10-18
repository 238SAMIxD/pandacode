export const WORKING_PHRASES = [
  'Growing a few good ideas…',
  'Untangling the bamboo branches…',
  'Checking for pandas in the code…',
  'Giving this idea room to grow…',
  'Herding curly braces…',
  'Consulting the rubber duck…',
  'Negotiating with semicolons…',
  'Untangling digital spaghetti…',
  'Turning coffee into code…',
  'Asking the pixels nicely…',
  'Teaching tabs some manners…',
  'Bribing the compiler…',
  'Connecting the nerd dots…',
  'Putting the bits in order…',
  'Looking for the missing bracket…',
  'Reticulating splines…',
  'Giving the logic a pep talk…',
  'Warming up the brain cell…',
  'Convincing the ones and zeros…',
  'Taking the scenic route through RAM…',
  'Untying a very small knot…',
  'Counting from zero, naturally…',
  'Adding a pinch of computer science…',
  'Politely questioning the code…',
  'Chasing a particularly clever bit…',
  'Organizing the organized chaos…',
  'Assembling the tiny gears…',
  'Giving the keyboard a side quest…',
];

export function nextWorkingPhrase(previous = ''): string {
  const choices = WORKING_PHRASES.filter(phrase => phrase !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}
