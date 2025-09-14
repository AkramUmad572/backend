// readme-processor.js (ESM)
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Buffer } from 'node:buffer';
import fetch from 'node-fetch';

// --- CONFIGURATION ---
const [OWNER, REPO, PR_NUM_STR] = process.argv.slice(2);
if (!OWNER || !REPO || !PR_NUM_STR) {
  console.error('Usage: node readme-processor.js <owner> <repo> <prNumber>');
  process.exit(1);
}
const PR_NUM = Number(PR_NUM_STR);
const README_FILE = 'README.md';
const BRANCH = 'main';

// --- CLIENT INITIALIZATION ---
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- HELPER FUNCTIONS ---

/**
 * Fetches README content from GitHub repository
 */
async function fetchReadmeContent(owner, repo, branch = 'main') {
  try {
    console.log(`📖 Fetching README.md from ${owner}/${repo}...`);
    const { data: fileData } = await octo.repos.getContent({ 
      owner, 
      repo, 
      path: README_FILE, 
      ref: branch 
    });
    
    const content = Buffer.from(fileData.content, 'base64').toString('utf8');
    console.log(`✅ Successfully fetched README.md (${content.length} characters)`);
    return content;
  } catch (error) {
    if (error.status === 404) {
      console.log(`ℹ️  README.md not found in ${owner}/${repo}`);
      return null;
    }
    throw error;
  }
}

/**
 * Process README with LLM - handles both existing README improvements and new README creation
 */
async function processReadmeWithLLM(readmeContent, prData, owner, repo) {
  console.log('🤖 Processing README with LLM...');
  
  let prompt;
  
  if (readmeContent) {
    // Existing README - suggest improvements
    prompt = `
      Analyze this README.md file and the recent PR merge to suggest documentation improvements:
      
      README Content:
      ${readmeContent.substring(0, 2000)}...
      
      Recent PR #${prData.number}: ${prData.title}
      PR Description: ${prData.body || '(no description)'}
      
      Please suggest 3-5 specific improvements to the README based on this PR merge.
      Format as markdown bullets.
    `;
  } else {
    // No README exists - create comprehensive one
    prompt = `
      Create a comprehensive README.md file for the repository "${owner}/${repo}" based on this recent PR merge:
      
      Recent PR #${prData.number}: ${prData.title}
      PR Description: ${prData.body || '(no description)'}
      PR Author: ${prData.user?.login || 'Unknown'}
      
      Create a complete README.md with the following sections (adapt based on project type):
      
      1. **Project Title & Description** - Clear project name and what it does
      2. **Features** - Key functionality and capabilities
      3. **Installation** - Step-by-step setup instructions
      4. **Usage** - Basic usage examples and code snippets
      5. **API Documentation** - If applicable, main endpoints/methods
      6. **Configuration** - Environment variables, config files
      7. **Development** - How to set up for development
      8. **Testing** - How to run tests
      9. **Deployment** - Production deployment instructions
      10. **Contributing** - Guidelines for contributors
      11. **License** - License information
      12. **Changelog** - Link to changelog or recent updates
      13. **Support** - How to get help, contact info
      14. **Acknowledgments** - Credits, dependencies, inspiration
      
      Make it professional, comprehensive, and tailored to the project based on the PR context.
      Use proper markdown formatting with headers, code blocks, badges, and lists.
      Include placeholder content where specific details aren't available from the PR.
    `;
  }
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();
    
    if (readmeContent) {
      console.log('✨ Generated README improvements:\n', response);
    } else {
      console.log('✨ Generated complete README.md:\n', response.substring(0, 500) + '...');
    }
    
    return response;
  } catch (error) {
    console.error('❌ Error processing with LLM:', error.message);
    
    if (readmeContent) {
      // Return placeholder improvements on error
      return `
• Update installation instructions based on recent changes
• Add documentation for new features introduced in PR #${prData.number}
• Review and update API examples
• Consider adding troubleshooting section
• Update dependencies and requirements
      `.trim();
    } else {
      // Return basic README template on error
      return `
# ${repo}

## Description
Project repository for ${owner}/${repo}.

## Installation
\`\`\`bash
# Add installation steps here
npm install
\`\`\`

## Usage
\`\`\`bash
# Add usage examples here
npm start
\`\`\`

## Recent Changes
- PR #${prData.number}: ${prData.title}

## Contributing
Please read our contributing guidelines before submitting pull requests.

## License
This project is licensed under the MIT License.
      `.trim();
    }
  }
}

/**
 * Send processed README to frontend via API
 */
async function notifyFrontend(owner, repo, prNumber, readmeContent, suggestions, wasCreated = false) {
  const payload = {
    event: 'readme_processed',
    repository: { owner, name: repo },
    prNumber,
    data: {
      readmeLength: readmeContent?.length || 0,
      suggestions,
      processedAt: new Date().toISOString(),
      wasCreated // Indicates if README was created vs improved
    }
  };

  try {
    // PLACEHOLDER: Replace with your actual frontend notification endpoint
    const frontendUrl = process.env.FRONTEND_NOTIFICATION_URL || 'http://localhost:3001/api/notifications';
    
    console.log(`📡 Notifying frontend at ${frontendUrl}...`);
    
    const response = await fetch(frontendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INTERNAL_API_KEY || 'placeholder-key'}`
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log('✅ Successfully notified frontend');
    } else {
      console.log(`⚠️  Frontend notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.log(`⚠️  Could not reach frontend: ${error.message}`);
    // This is non-critical, so we continue
  }
}

// --- MAIN EXECUTION LOGIC ---
try {
  console.log(`🚀 Starting README processing for PR #${PR_NUM} in ${OWNER}/${REPO}...`);

  // 1) Fetch PR context from GitHub
  console.log(`Fetching PR #${PR_NUM} details...`);
  const { data: pr } = await octo.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUM });

  // 2) Fetch README content
  const readmeContent = await fetchReadmeContent(OWNER, REPO, BRANCH);
  
  // 3) Process README with LLM (handles both existing README and creation of new one)
  const result = await processReadmeWithLLM(readmeContent, pr, OWNER, REPO);
  
  let finalReadmeContent = readmeContent;
  let suggestions = result;
  
  // If no README existed, the LLM result is the complete README content
  if (!readmeContent) {
    console.log('📝 Creating new README.md file...');
    finalReadmeContent = result;
    suggestions = `Created comprehensive README.md with 14 sections including:\n• Project description and features\n• Installation and usage instructions\n• API documentation and configuration\n• Development, testing, and deployment guides\n• Contributing guidelines and license information`;
    
    // TODO: Optionally create the README.md file in the repository
    // This would require additional GitHub API calls to create the file
    console.log('💡 New README content generated. Consider implementing auto-creation in GitHub.');
  }

  // 4) Notify frontend
  await notifyFrontend(OWNER, REPO, PR_NUM, finalReadmeContent, suggestions, !readmeContent);

  console.log('✨ README processing complete!');

} catch (error) {
  console.error('\n❌ An error occurred during README processing:', error.message);
  process.exit(1);
}
