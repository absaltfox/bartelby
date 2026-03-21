const { initializeSchema, documents, transcripts, annotations, getDb } = require('./db');

// Sample historical documents
const sampleDocuments = [
  {
    title: 'Declaration of Independence Draft',
    date_created: '1776-06-11',
    description: 'Early draft of the Declaration of Independence with annotations by Thomas Jefferson',
    image_path: '/uploads/declaration_draft.jpg',
    metadata: { author: 'Thomas Jefferson', location: 'Philadelphia', type: 'manuscript' }
  },
  {
    title: 'Civil War Soldier Letter',
    date_created: '1863-07-05',
    description: 'Personal letter from a Union soldier to his family after the Battle of Gettysburg',
    image_path: '/uploads/civil_war_letter.jpg',
    metadata: { author: 'Pvt. John Smith', location: 'Gettysburg, PA', type: 'correspondence' }
  },
  {
    title: 'Immigration Record - Ellis Island',
    date_created: '1905-04-12',
    description: 'Ship manifest recording immigrants arriving at Ellis Island',
    image_path: '/uploads/ellis_island_manifest.jpg',
    metadata: { ship: 'SS Baltic', port_of_origin: 'Liverpool', type: 'official record' }
  },
  {
    title: 'Homestead Act Land Claim',
    date_created: '1868-09-15',
    description: 'Original land claim document under the Homestead Act in Nebraska Territory',
    image_path: '/uploads/homestead_claim.jpg',
    metadata: { claimant: 'William Johnson', acres: 160, type: 'legal document' }
  },
  {
    title: 'Colonial Trade Ledger',
    date_created: '1752-03-22',
    description: 'Merchant ledger recording goods traded between Boston and London',
    image_path: '/uploads/trade_ledger.jpg',
    metadata: { merchant: 'Samuel Adams Sr.', location: 'Boston', type: 'financial record' }
  }
];

const sampleTranscripts = [
  {
    document_id: 1,
    content: `When in the Course of human events, it becomes necessary for one people to dissolve the political bands which have connected them with another, and to assume among the powers of the earth, the separate and equal station to which the Laws of Nature and of Nature's God entitle them, a decent respect to the opinions of mankind requires that they should declare the causes which impel them to the separation.

We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness.`,
    transcriber: 'Dr. Sarah Mitchell',
    version: 1,
    notes: 'Initial transcription from high-resolution scan. Some words difficult to read due to age of document.'
  },
  {
    document_id: 1,
    content: `When in the Course of human events, it becomes necessary for one people to dissolve the political bands which have connected them with another, and to assume among the powers of the earth, the separate and equal station to which the Laws of Nature and of Nature's God entitle them, a decent respect to the opinions of mankind requires that they should declare the causes which impel them to the separation.

We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness.

[Note: Crossed out section] "that all men are created equal & independant"`,
    transcriber: 'Prof. James Walker',
    version: 2,
    notes: 'Revised transcription including Jefferson\'s crossed-out annotations visible under UV light.'
  },
  {
    document_id: 2,
    content: `July 5th, 1863
Dear Martha,

I write to you with great relief that I have survived the terrible battle these past three days. The fighting at Gettysburg was unlike anything I have witnessed. The cannon fire was so loud and constant that my ears still ring as I write these words.

Many of our brave boys fell in the wheat fields and orchards. I shall never forget their sacrifice. General Meade has led us well, and though the cost was great, we have turned back the rebel army.

I pray this war will end soon so that I may return to you and the children. Kiss little Thomas for me.

Your loving husband,
John`,
    transcriber: 'Emily Chen',
    version: 1,
    notes: 'Letter has water damage in lower right corner. Some words interpreted from context.'
  },
  {
    document_id: 3,
    content: `SHIP MANIFEST - SS Baltic
Arriving: April 12, 1905
Port of Entry: Ellis Island, New York

Passenger List (Steerage Class):
1. Kowalski, Jan - Age 32 - Poland - Laborer
2. Kowalski, Maria - Age 28 - Poland - Housewife
3. Kowalski, Stefan - Age 6 - Poland - Child
4. O'Brien, Patrick - Age 25 - Ireland - Farmer
5. Rosenberg, Isaac - Age 45 - Russia - Tailor
6. Rosenberg, Esther - Age 42 - Russia - Housewife
7. Rosenberg, David - Age 18 - Russia - Student
8. Rosenberg, Rachel - Age 15 - Russia - Student`,
    transcriber: 'Michael Torres',
    version: 1,
    notes: 'Complete transcription of visible passenger entries. Additional pages may exist.'
  },
  {
    document_id: 4,
    content: `HOMESTEAD ENTRY
Land Office at Lincoln, Nebraska
September 15, 1868

William Johnson, having filed his application to enter under the Homestead Act of May 20, 1862, the following described land:
The Southeast Quarter of Section 14, Township 8 North, Range 2 East of the 6th Principal Meridian, containing 160 acres.

The said William Johnson having complied with all the requirements of law, and having established actual residence upon said land, is hereby granted this certificate of entry.

[Signature]
Register of the Land Office`,
    transcriber: 'Dr. Rebecca Adams',
    version: 1,
    notes: 'Document in good condition. All text clearly legible.'
  },
  {
    document_id: 5,
    content: `Ledger of Samuel Adams, Merchant
Boston, Massachusetts
March 22, 1752

GOODS RECEIVED from London per ship "Providence":
- 12 bolts fine English wool cloth @ £3.2s each
- 50 lbs Ceylon tea @ 4s per lb
- 24 bottles French brandy @ 8s each
- 6 cases window glass @ £2 each
- Sundry hardware goods - £15.7s

GOODS SHIPPED to London:
- 200 barrels salt cod @ 12s each
- 50 hogsheads tobacco @ £4 each
- 100 bushels Indian corn @ 2s each
- 20 barrels whale oil @ £3 each

Total Credits: £382.7s
Total Debits: £267.12s
Balance Due: £114.15s`,
    transcriber: 'Prof. Thomas Barrett',
    version: 1,
    notes: 'Transcription includes monetary values in pounds, shillings, and pence. Some entries abbreviated in original.'
  }
];

const sampleAnnotations = [
  {
    transcript_id: 1,
    user_name: 'Historian_Jane',
    content: 'This phrase was revolutionary for its time, asserting natural equality.',
    position_start: 298,
    position_end: 330
  },
  {
    transcript_id: 1,
    user_name: 'Student_Mike',
    content: 'What did "unalienable" mean in the 18th century context?',
    position_start: 391,
    position_end: 401
  },
  {
    transcript_id: 3,
    user_name: 'Genealogist_Pat',
    content: 'The Kowalski family likely settled in Chicago based on other records.',
    position_start: 147,
    position_end: 155
  }
];

async function seed() {
  // Initialize schema first
  await initializeSchema();

  const { saveDatabase } = require('./db');

  // Clear existing data (ignore errors if tables are empty)
  const database = getDb();
  try { database.run('DELETE FROM annotations'); } catch (e) {}
  try { database.run('DELETE FROM transcripts'); } catch (e) {}
  try { database.run('DELETE FROM documents'); } catch (e) {}
  saveDatabase();

  console.log('Seeding database...');

  sampleDocuments.forEach(doc => {
    documents.create(doc);
  });
  console.log(`Inserted ${sampleDocuments.length} documents`);

  sampleTranscripts.forEach(transcript => {
    transcripts.create(transcript);
  });
  console.log(`Inserted ${sampleTranscripts.length} transcripts`);

  sampleAnnotations.forEach(annotation => {
    annotations.create(annotation);
  });
  console.log(`Inserted ${sampleAnnotations.length} annotations`);

  saveDatabase();
  console.log('Database seeded successfully!');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
