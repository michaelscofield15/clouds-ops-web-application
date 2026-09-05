const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || "mongodb+srv://jaswanthyalavarthi757_db_user:z5OZMlRSxXlCJEuG@cluster0.2ysbgim.mongodb.net/cloudops?retryWrites=true&w=majority&appName=Cluster0";

async function main() {
  console.log('[Seed] Connecting to MongoDB Atlas...');
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000
  });

  try {
    await client.connect();
    console.log('[Seed] Connected successfully.');
    const db = client.db('cloudops');

    // Ensure collections exist with initial records
    const orgsCol = db.collection('organizations');
    await orgsCol.updateOne(
      { id: 'org-cloudops-prod' },
      {
        $set: {
          id: 'org-cloudops-prod',
          name: 'CloudOps Production Workspace',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    console.log('[Seed] Seeded organizations collection');

    const projectsCol = db.collection('projects');
    await projectsCol.updateOne(
      { id: 'proj-cloudops-platform' },
      {
        $set: {
          id: 'proj-cloudops-platform',
          name: 'cloudops-platform',
          organizationId: 'org-cloudops-prod',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    console.log('[Seed] Seeded projects collection');

    const auditCol = db.collection('audit_events');
    await auditCol.updateOne(
      { id: 'audit-init-001' },
      {
        $set: {
          id: 'audit-init-001',
          action: 'SYSTEM_INITIALIZE',
          details: 'CloudOps MongoDB Atlas database connected and initialized',
          timestamp: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    console.log('[Seed] Seeded audit_events collection');

    const collections = await db.listCollections().toArray();
    console.log('[Seed] Collections currently in database "cloudops":', collections.map(c => c.name));

    await client.close();
    console.log('[Seed] Finished successfully!');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Error:', err);
    process.exit(1);
  }
}

main();
