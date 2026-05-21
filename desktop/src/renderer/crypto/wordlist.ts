/**
 * 256-word evocative list for fingerprint display.
 * 8 bits per word, 8 words = 64 bits. Replaced by BIP-39/PGP wordlist in Fase 3.
 */
export const WORDLIST_256: readonly string[] = [
  'amber', 'anchor', 'apple', 'arrow', 'atlas', 'azure', 'badge', 'banjo',
  'basin', 'basil', 'beach', 'beacon', 'beast', 'birch', 'bison', 'blade',
  'blaze', 'bloom', 'boat', 'bolt', 'bone', 'book', 'boots', 'boulder',
  'brass', 'bread', 'brick', 'bridge', 'bronze', 'brook', 'broth', 'bud',
  'cabin', 'cactus', 'camel', 'canyon', 'cape', 'cargo', 'carve', 'cedar',
  'chain', 'chalk', 'charm', 'chess', 'chime', 'cider', 'clay', 'cliff',
  'clock', 'cloud', 'clove', 'clover', 'coast', 'cobalt', 'coil', 'comet',
  'copper', 'coral', 'cork', 'cotton', 'cove', 'crag', 'crane', 'crater',
  'creek', 'crest', 'crow', 'crown', 'crust', 'crystal', 'cube', 'dagger',
  'daisy', 'dawn', 'delta', 'desert', 'diamond', 'dock', 'drift', 'drum',
  'dune', 'dusk', 'eagle', 'earth', 'ebony', 'echo', 'eden', 'eel',
  'ember', 'enzyme', 'epoch', 'fable', 'falcon', 'fern', 'field', 'fig',
  'finch', 'fjord', 'flame', 'flask', 'flint', 'floe', 'flora', 'flute',
  'forest', 'forge', 'fox', 'frost', 'galaxy', 'garden', 'gate', 'gecko',
  'gem', 'ghost', 'ginger', 'glade', 'glass', 'globe', 'goose', 'gorge',
  'grain', 'granite', 'grass', 'grove', 'gull', 'hammer', 'harbor', 'haven',
  'hawk', 'heart', 'helix', 'hemlock', 'hill', 'honey', 'horizon', 'hyena',
  'ice', 'iris', 'ivory', 'jade', 'jaguar', 'jasper', 'jet', 'jungle',
  'kelp', 'kettle', 'kite', 'koi', 'lagoon', 'lake', 'lantern', 'larch',
  'lark', 'lava', 'leaf', 'lemon', 'lens', 'lever', 'lilac', 'lime',
  'linen', 'lion', 'lobby', 'loom', 'lotus', 'lynx', 'magnet', 'maple',
  'marble', 'marsh', 'mast', 'meadow', 'medal', 'melon', 'meteor', 'mica',
  'mint', 'mirror', 'mist', 'moose', 'moss', 'moth', 'motor', 'nectar',
  'needle', 'nest', 'nettle', 'nimbus', 'oak', 'oat', 'ocean', 'olive',
  'onyx', 'opal', 'orbit', 'orchid', 'otter', 'oven', 'owl', 'oyster',
  'palm', 'panda', 'panel', 'paper', 'parrot', 'path', 'peach', 'pearl',
  'pebble', 'pewter', 'piano', 'pier', 'pine', 'pixel', 'plain', 'planet',
  'plum', 'pond', 'poppy', 'prairie', 'prism', 'puma', 'quartz', 'quest',
  'quill', 'quilt', 'rabbit', 'radar', 'rain', 'raven', 'reef', 'relay',
  'resin', 'ribbon', 'ridge', 'river', 'robin', 'rocket', 'rose', 'ruby',
  'rune', 'saffron', 'sage', 'salmon', 'sand', 'sapphire', 'satin', 'sauna',
  'scarf', 'sea', 'seed', 'shell', 'shore', 'silk', 'silver', 'sky',
];

if (WORDLIST_256.length !== 256) {
  throw new Error(`WORDLIST_256 must have 256 entries, got ${WORDLIST_256.length}`);
}
