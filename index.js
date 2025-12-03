// Asana to Google Drive Backup Agent
// Deploy to Vercel or Railway (free tier)

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();

app.use(express.json());

// Configuration from environment variables
const ASANA_ACCESS_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const ASANA_WORKSPACE_ID = process.env.ASANA_WORKSPACE_ID;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Google Drive authentication - FIXED SCOPES
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets'
  ],
});

const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

// Main backup endpoint - triggered by Zapier webhook
app.post('/backup-asana', async (req, res) => {
  try {
    console.log('Starting Asana backup process...');
    
    // 1. Fetch all projects from workspace
    const projects = await fetchAsanaProjects();
    console.log(`Found ${projects.length} projects`);
    
    // 2. For each project, fetch tasks and create backup
    const backupResults = [];
    
    for (const project of projects) {
      try {
        const tasks = await fetchProjectTasks(project.gid);
        const backupResult = await createProjectBackup(project, tasks);
        backupResults.push(backupResult);
        console.log(`Successfully backed up: ${project.name}`);
      } catch (error) {
        console.error(`Error backing up project ${project.name}:`, error.message);
        backupResults.push({
          project: project.name,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    // 3. Create summary report
    const summary = {
      timestamp: new Date().toISOString(),
      totalProjects: projects.length,
      successful: backupResults.filter(r => r.status === 'success').length,
      failed: backupResults.filter(r => r.status === 'failed').length,
      results: backupResults
    };
    
    res.json({
      success: true,
      message: 'Backup completed',
      summary
    });
    
  } catch (error) {
    console.error('Backup failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Fetch all projects from Asana workspace
async function fetchAsanaProjects() {
  const response = await axios.get(
    `https://app.asana.com/api/1.0/workspaces/${ASANA_WORKSPACE_ID}/projects`,
    {
      headers: {
        'Authorization': `Bearer ${ASANA_ACCESS_TOKEN}`
      },
      params: {
        opt_fields: 'name,created_at,modified_at,archived,notes,owner.name'
      }
    }
  );
  
  return response.data.data;
}

// Fetch all tasks for a specific project
async function fetchProjectTasks(projectGid) {
  const tasks = [];
  let offset = null;
  
  do {
    const response = await axios.get(
      `https://app.asana.com/api/1.0/projects/${projectGid}/tasks`,
      {
        headers: {
          'Authorization': `Bearer ${ASANA_ACCESS_TOKEN}`
        },
        params: {
          opt_fields: 'name,completed,completed_at,due_on,due_at,assignee.name,notes,tags.name,custom_fields,created_at,modified_at,permalink_url',
          limit: 100,
          offset: offset
        }
      }
    );
    
    tasks.push(...response.data.data);
    offset = response.data.next_page?.offset;
    
  } while (offset);
  
  return tasks;
}

// Create or update project folder and backup spreadsheet
async function createProjectBackup(project, tasks) {
  try {
    // 1. Find or create project folder
    const folderName = `${project.name} - Asana Backup`;
    const folderId = await findOrCreateFolder(folderName, GOOGLE_DRIVE_FOLDER_ID);
    
    // 2. Create timestamp for this backup
    const timestamp = new Date().toISOString().split('T')[0];
    const fileName = `Backup_${timestamp}`;
    
    // 3. Create spreadsheet with tasks
    const spreadsheetId = await createTasksSpreadsheet(fileName, folderId, project, tasks);
    
    return {
      project: project.name,
      status: 'success',
      tasksCount: tasks.length,
      folderId,
      spreadsheetId,
      timestamp
    };
    
  } catch (error) {
    throw new Error(`Failed to backup ${project.name}: ${error.message}`);
  }
}

// Find or create a folder in Google Drive
async function findOrCreateFolder(folderName, parentFolderId) {
  // Search for existing folder
  const query = `name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  
  const searchResponse = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  
  if (searchResponse.data.files.length > 0) {
    return searchResponse.data.files[0].id;
  }
  
  // Create new folder
  const folderMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId]
  };
  
  const folder = await drive.files.create({
    resource: folderMetadata,
    fields: 'id'
  });
  
  return folder.data.id;
}

// Create Google Sheets spreadsheet with tasks
async function createTasksSpreadsheet(fileName, folderId, project, tasks) {
  // Create new spreadsheet
  const spreadsheet = await sheets.spreadsheets.create({
    resource: {
      properties: {
        title: fileName
      },
      sheets: [
        {
          properties: {
            title: 'Tasks',
            gridProperties: {
              frozenRowCount: 1
            }
          }
        },
        {
          properties: {
            title: 'Project Info'
          }
        }
      ]
    }
  });
  
  const spreadsheetId = spreadsheet.data.spreadsheetId;
  
  // Move to correct folder
  await drive.files.update({
    fileId: spreadsheetId,
    addParents: folderId,
    fields: 'id, parents'
  });
  
  // Prepare tasks data
  const headers = [
    'Task Name', 'Status', 'Assignee', 'Due Date', 
    'Completed Date', 'Tags', 'Notes', 'URL', 
    'Created At', 'Modified At'
  ];
  
  const rows = tasks.map(task => [
    task.name || '',
    task.completed ? 'Completed' : 'Incomplete',
    task.assignee?.name || 'Unassigned',
    task.due_on || task.due_at || '',
    task.completed_at || '',
    task.tags?.map(t => t.name).join(', ') || '',
    task.notes || '',
    task.permalink_url || '',
    task.created_at || '',
    task.modified_at || ''
  ]);
  
  // Write tasks data
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Tasks!A1',
    valueInputOption: 'RAW',
    resource: {
      values: [headers, ...rows]
    }
  });
  
  // Write project info
  const projectInfo = [
    ['Project Name', project.name],
    ['Project ID', project.gid],
    ['Created At', project.created_at],
    ['Modified At', project.modified_at],
    ['Owner', project.owner?.name || 'N/A'],
    ['Archived', project.archived ? 'Yes' : 'No'],
    ['Notes', project.notes || ''],
    ['Backup Date', new Date().toISOString()],
    ['Total Tasks', tasks.length],
    ['Completed Tasks', tasks.filter(t => t.completed).length],
    ['Incomplete Tasks', tasks.filter(t => !t.completed).length]
  ];
  
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Project Info!A1',
    valueInputOption: 'RAW',
    resource: {
      values: projectInfo
    }
  });
  
  // Format the spreadsheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: 0,
              startRowIndex: 0,
              endRowIndex: 1
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.6, blue: 0.86 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)'
          }
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: 0,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 10
            }
          }
        }
      ]
    }
  });
  
  return spreadsheetId;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Test endpoint for manual trigger
app.get('/test', (req, res) => {
  res.json({
    message: 'Agent is running',
    configured: {
      asana: !!ASANA_ACCESS_TOKEN,
      workspace: !!ASANA_WORKSPACE_ID,
      drive: !!GOOGLE_DRIVE_FOLDER_ID,
      serviceAccount: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Asana Backup Agent running on port ${PORT}`);
});

module.exports = app;
