/**
 * Debug harness for Claude Context Bar extension
 *
 * Uses the shared detectSessions module for session scanning and ghost-session
 * filtering. This file is responsible only for formatted diagnostic output.
 *
 * Run with: npm run compile && node out/debug.js
 */

import * as fs from 'fs';
import { getClaudeProjectsDir } from './sessionFile';
import { detectSessions, SessionInfo, DetectionOptions } from './sessionDetection';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEBUG_OPTIONS: DetectionOptions = {
    idleTimeout: 5 * 60, // 5 minutes — match legacy debug.ts cutoff
    contextLimit: 200_000,
    modelContextLimits: {},
};

// ============================================================================
// DEBUG RUNNER
// ============================================================================

async function debugSessions(projectFilter?: string) {
    const claudeDir = getClaudeProjectsDir();
    console.log(`\n========== CLAUDE CONTEXT BAR DEBUG ==========`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Claude dir: ${claudeDir}\n`);

    if (!fs.existsSync(claudeDir)) {
        console.log("Claude projects directory not found!");
        return;
    }

    const sessions = await detectSessions(claudeDir, DEBUG_OPTIONS);
    const filtered = projectFilter
        ? sessions.filter(s => s.projectName.includes(projectFilter) || s.projectPath.includes(projectFilter))
        : sessions;

    // Group by project path (stable — not mutated by processSessionGroups)
    const projectGroups = new Map<string, SessionInfo[]>();
    for (const session of filtered) {
        const key = session.projectPath;
        if (!projectGroups.has(key)) {
            projectGroups.set(key, []);
        }
        projectGroups.get(key)!.push(session);
    }

    for (const [projectPath, group] of projectGroups) {
        console.log(`\n--- Project: ${projectPath} ---`);
        console.log(`Sessions: ${group.length}\n`);

        for (const session of group) {
            console.log(`  📄 ${session.sessionId}...`);
            console.log(`     Created:  ${session.sessionCreated?.toISOString() || 'unknown'}`);
            console.log(`     LastUpd:  ${session.lastUpdated.toISOString()}`);
            console.log(`     Model:    ${session.model}`);
            console.log(`     Tokens:   ${session.totalTokens} / ${session.contextLimit} (${session.percentage}%)`);
            console.log(`     Cleared:  ${session.wasCleared}`);
            console.log(`     FirstMsg: "${session.firstMessage}"`);
            console.log('');
        }
    }

    console.log(`========== SUMMARY ==========`);
    console.log(`Active sessions (ghost-filtered by detectSessions): ${filtered.length}`);
}

// Run with optional project filter
const projectFilter = process.argv[2] || undefined;
debugSessions(projectFilter);
