// Static copy for the general-site pages (About, Beliefs, News, Directory).
// Grace Community Church is fictional: swap this text for the real church's wording before launch.

export const MISSION = 'Helping people find their people: to know God, belong to a community, and serve the neighbors around us.';

export const STORY = [
  'Grace Community started in 1998 as a handful of families meeting in a Springfield living room. Today we gather on Maple Ridge Road for three services a week, with a kids ministry, student ministry and a network of small groups that meet all over town.',
  'We have always believed a church works best when it feels small. However many people walk through the doors on Sunday, we want each one to be known by name, to have a table to sit at, and to have a place to use their gifts.',
];

export const VALUES = [
  { icon: 'heart', color: 'color0', title: 'Welcome first', text: 'Come as you are. Nobody has to have it figured out to belong here.' },
  { icon: 'book', color: 'color3', title: 'Rooted in Scripture', text: 'We teach the Bible plainly and trust it to speak for itself.' },
  { icon: 'users', color: 'color1', title: 'Life together', text: 'Faith is not a solo project. We grow in groups, meals and long conversations.' },
  { icon: 'compass', color: 'color4', title: 'Sent to serve', text: 'The mission reaches past our walls: our neighbors, our city and the world.' },
];

export const BELIEFS = [
  { title: 'The Bible', text: 'We believe the Bible, Old and New Testaments, is God’s inspired and trustworthy word, and the final authority for what we believe and how we live.' },
  { title: 'God', text: 'We believe in one God, eternally existing as Father, Son and Holy Spirit: three persons, equal in glory, one in being.' },
  { title: 'Jesus Christ', text: 'We believe Jesus is fully God and fully human, born of the virgin Mary, who lived a sinless life, died on the cross for our sins, rose bodily from the dead, and ascended to the Father.' },
  { title: 'The Holy Spirit', text: 'We believe the Holy Spirit convicts the world of sin, gives new life to believers, lives in them, and equips the church with gifts for serving others.' },
  { title: 'People', text: 'We believe every person is made in the image of God and has dignity and worth. Sin has broken our relationship with God and with each other, and we cannot repair it ourselves.' },
  { title: 'Salvation', text: 'We believe salvation is a gift of God’s grace, received through faith in Jesus Christ alone, not by anything we earn.' },
  { title: 'The church', text: 'We believe the church is the family of all who follow Jesus, called to worship, to love one another, to make disciples and to care for the needy.' },
  { title: 'Baptism & communion', text: 'We practice baptism as a public sign of new life in Christ, and communion as a regular remembrance of his death and resurrection.' },
  { title: 'Christ’s return', text: 'We believe Jesus will return in glory to judge the living and the dead and to make all things new.' },
];

export const NEWS_CATEGORIES = ['All', 'Church life', 'Serve', 'Families', 'Worship'];

export const NEWS = [
  { id: 1, date: '2026-10-01', category: 'Serve', title: 'Serve Day is October 17', text: 'Teams head out to local schools, the food pantry and elderly neighbors for the morning. All ages are welcome; meet in the main parking lot at 8:30am.', cta: ['serve', 'See where help is needed'] },
  { id: 2, date: '2026-09-28', category: 'Families', title: 'Fall family picnic after church, October 25', text: 'Food trucks, games and a bounce house on the church lawn after the 11:00am service. It is a great first event if you are new.', cta: ['calendar', 'View the calendar'] },
  { id: 3, date: '2026-09-22', category: 'Serve', title: 'Welcome team training on October 11', text: 'A 45-minute training for new greeters and guest services volunteers, right after the 11:00am service in the lobby.', cta: ['guests/welcome', 'Meet the welcome team'] },
  { id: 4, date: '2026-09-15', category: 'Worship', title: 'Worship night returns November 6', text: 'An evening of music and prayer led by the worship collective in the main auditorium. Bring a friend.', cta: ['calendar', 'View the calendar'] },
  { id: 5, date: '2026-09-08', category: 'Church life', title: 'Discover Grace: your first step toward membership', text: 'Offered the first Sunday of each month after the 11:00am service. Lunch and childcare are provided.', cta: ['connect', 'Connect with us'] },
  { id: 6, date: '2026-08-30', category: 'Families', title: 'Kids ministry is looking for more helpers', text: 'Sunday mornings run best with a full team. Training is provided and a background check is required.', cta: ['serve/find', 'Find a place to serve'] },
];

// Pastors and staff shown above the ministry leads in the directory.
export const STAFF = [
  { name: 'Pastor Daniel Whitaker', role: 'Lead pastor', email: 'daniel.whitaker@example.com', note: 'Preaching, vision and pastoral questions.' },
  { name: 'Pastor Naomi Alvarez', role: 'Care pastor', email: 'naomi.alvarez@example.com', note: 'Prayer, hospital visits, grief and crisis support.' },
  { name: 'Tom Hendricks', role: 'Executive director', email: 'tom.hendricks@example.com', note: 'Facilities, finance and building use.' },
  { name: 'Priya Nair', role: 'Office manager', email: 'priya.nair@example.com', note: 'General questions, room bookings and the church directory.' },
];

export const CONNECT_INTERESTS = [
  'I am new and have questions',
  'I would like to join a small group',
  'I would like to serve',
  'I need prayer or care',
  'I would like to talk to a pastor',
  'Something else',
];
