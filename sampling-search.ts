/**
 * @fileoverview MCP Sampling-based intelligent search result selection
 * 
 * This module implements MCP sampling to intelligently select and rank search results
 * based on relevance to user queries using LLM-powered analysis.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  ModelPreferencesSchema,
  SamplingMessageSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js'
import axios from 'axios'

// Configuration for sampling-based search
interface SamplingSearchConfig {
  maxResults: number
  minRelevanceScore: number
  enableContextAwareFiltering: boolean
  enableSessionTracking: boolean
  modelPreferences?: {
    intelligencePriority?: number
    speedPriority?: number
    costPriority?: number
  }
}

// Enhanced search result with relevance metadata
interface EnhancedSearchResult {
  url: string
  title: string
  overview: string
  content?: string
  moduleId?: string
  relevanceScore?: number
  relevanceReason?: string
  contextMatch?: string[]
}

// Session context for tracking search history
interface SearchSessionContext {
  sessionId: string
  searchHistory: string[]
  viewedUrls: Set<string>
  searchIntent?: string
  refinementCount: number
}

export class SamplingSearchHandler {
  private server: Server
  private config: SamplingSearchConfig
  private sessions: Map<string, SearchSessionContext> = new Map()

  constructor(server: Server, config?: Partial<SamplingSearchConfig>) {
    this.server = server
    this.config = {
      maxResults: 5,
      minRelevanceScore: 0.7,
      enableContextAwareFiltering: true,
      enableSessionTracking: true,
      modelPreferences: {
        intelligencePriority: 0.7,
        speedPriority: 0.6,
        costPriority: 0.4,
      },
      ...config,
    }
  }

  /**
   * Performs intelligent search with MCP sampling for result selection
   */
  async performSamplingSearch(
    query: string,
    sessionId?: string,
    apiKey?: string
  ): Promise<EnhancedSearchResult[]> {
    // Get session context if available
    const session = sessionId ? this.getOrCreateSession(sessionId) : undefined
    
    // Fetch initial search results
    const rawResults = await this.fetchSearchResults(query, apiKey)
    
    if (rawResults.length === 0) {
      return []
    }

    // Track search in session
    if (session) {
      session.searchHistory.push(query)
      session.refinementCount++
    }

    // Use MCP sampling to analyze and rank results
    const rankedResults = await this.rankResultsWithSampling(
      rawResults,
      query,
      session
    )

    // Filter based on session history
    const filteredResults = this.filterBySessionHistory(rankedResults, session)

    // Apply relevance threshold
    const relevantResults = filteredResults.filter(
      r => (r.relevanceScore || 0) >= this.config.minRelevanceScore
    )

    // Limit to max results
    const finalResults = relevantResults.slice(0, this.config.maxResults)

    // Update session with viewed URLs
    if (session) {
      finalResults.forEach(r => session.viewedUrls.add(r.url))
    }

    return finalResults
  }

  /**
   * Uses MCP sampling to analyze and rank search results
   */
  private async rankResultsWithSampling(
    results: any[],
    query: string,
    session?: SearchSessionContext
  ): Promise<EnhancedSearchResult[]> {
    try {
      // Check if client supports sampling
      if (!this.server['_clientCapabilities']?.sampling) {
        console.warn('Client does not support sampling, falling back to basic ranking')
        return this.basicRanking(results)
      }

      // Prepare sampling prompt
      const systemPrompt = this.buildSystemPrompt(session)
      const userMessage = this.buildRankingPrompt(results, query, session)

      // Create sampling request
      const samplingRequest: CreateMessageRequest = {
        method: 'sampling/createMessage' as const,
        params: {
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: userMessage,
              },
            },
          ],
          systemPrompt,
          modelPreferences: this.config.modelPreferences,
          maxTokens: 1000,
        },
      }

      // Request LLM analysis via sampling
      const samplingResult = await this.server['createMessage'](samplingRequest.params)
      
      // Parse the LLM response
      const rankings = this.parseSamplingResponse(samplingResult, results)
      
      return rankings
    } catch (error) {
      console.error('Sampling failed, falling back to basic ranking:', error)
      return this.basicRanking(results)
    }
  }

  /**
   * Builds the system prompt for sampling
   */
  private buildSystemPrompt(session?: SearchSessionContext): string {
    let prompt = `You are an intelligent search result ranking system for technical documentation.
Your task is to analyze search results and rank them by relevance to the user's query.

Consider the following factors:
1. Direct relevance to the search query
2. Technical depth and specificity
3. Recency and accuracy of information
4. Practical applicability`

    if (session && session.searchIntent) {
      prompt += `\n\nUser's apparent intent: ${session.searchIntent}`
    }

    if (session && session.searchHistory.length > 1) {
      prompt += `\n\nPrevious searches in this session: ${session.searchHistory.slice(-3).join(', ')}`
    }

    return prompt
  }

  /**
   * Builds the ranking prompt for the LLM
   */
  private buildRankingPrompt(
    results: any[],
    query: string,
    session?: SearchSessionContext
  ): string {
    const resultsJson = results.map((r, i) => ({
      index: i,
      title: r.title || r.overview || '',
      url: r.url,
      snippet: (r.content || r.overview || '').slice(0, 200),
    }))

    let prompt = `Query: "${query}"\n\n`
    prompt += `Search Results:\n${JSON.stringify(resultsJson, null, 2)}\n\n`
    
    if (session && session.viewedUrls.size > 0) {
      prompt += `Previously viewed URLs (avoid duplicates): ${Array.from(session.viewedUrls).join(', ')}\n\n`
    }

    prompt += `Please analyze these search results and return a JSON array ranking them by relevance.
Each item should have:
- index: original result index
- relevanceScore: 0-1 score
- relevanceReason: brief explanation
- contextMatch: array of matching concepts/keywords

Return ONLY valid JSON, no additional text.`

    return prompt
  }

  /**
   * Parses the LLM sampling response into ranked results
   */
  private parseSamplingResponse(
    samplingResult: CreateMessageResult,
    originalResults: any[]
  ): EnhancedSearchResult[] {
    try {
      // Extract text content from the sampling result
      const content = samplingResult.message.content
      let textContent = ''
      
      if (typeof content === 'string') {
        textContent = content
      } else if (Array.isArray(content)) {
        textContent = content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('')
      } else if (content.type === 'text') {
        textContent = content.text
      }

      // Parse JSON from response
      const rankings = JSON.parse(textContent)
      
      // Map rankings back to enhanced results
      const enhancedResults: EnhancedSearchResult[] = rankings
        .sort((a: any, b: any) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
        .map((ranking: any) => {
          const original = originalResults[ranking.index]
          return {
            url: original.url,
            title: original.title || original.overview || '',
            overview: original.overview || '',
            content: original.content,
            moduleId: original.moduleId,
            relevanceScore: ranking.relevanceScore,
            relevanceReason: ranking.relevanceReason,
            contextMatch: ranking.contextMatch,
          }
        })

      return enhancedResults
    } catch (error) {
      console.error('Failed to parse sampling response:', error)
      return this.basicRanking(originalResults)
    }
  }

  /**
   * Basic ranking fallback when sampling is not available
   */
  private basicRanking(results: any[]): EnhancedSearchResult[] {
    return results.map(r => ({
      url: r.url,
      title: r.title || r.overview || '',
      overview: r.overview || '',
      content: r.content,
      moduleId: r.moduleId,
      relevanceScore: 0.5, // Default score
    }))
  }

  /**
   * Filters results based on session history
   */
  private filterBySessionHistory(
    results: EnhancedSearchResult[],
    session?: SearchSessionContext
  ): EnhancedSearchResult[] {
    if (!session || !this.config.enableSessionTracking) {
      return results
    }

    // Filter out previously viewed URLs unless they're highly relevant
    return results.filter(r => {
      if (session.viewedUrls.has(r.url)) {
        // Only include if relevance score is very high
        return (r.relevanceScore || 0) > 0.9
      }
      return true
    })
  }

  /**
   * Fetches raw search results from the API
   */
  private async fetchSearchResults(query: string, apiKey?: string): Promise<any[]> {
    const url = `${this.getRefUrl()}/search_documentation?query=${encodeURIComponent(query)}`
    
    try {
      const response = await axios.get(url, {
        headers: this.getAuthHeaders(apiKey),
      })
      
      return response.data.docs || []
    } catch (error) {
      console.error('Search API error:', error)
      return []
    }
  }

  /**
   * Gets or creates a session context
   */
  private getOrCreateSession(sessionId: string): SearchSessionContext {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        searchHistory: [],
        viewedUrls: new Set(),
        refinementCount: 0,
      })
    }
    return this.sessions.get(sessionId)!
  }

  /**
   * Analyzes search intent from history using sampling
   */
  async analyzeSearchIntent(sessionId: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId)
    if (!session || session.searchHistory.length < 2) {
      return undefined
    }

    try {
      const samplingRequest: CreateMessageRequest = {
        method: 'sampling/createMessage' as const,
        params: {
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Analyze these search queries and identify the user's intent in 1-2 sentences:
${session.searchHistory.join('\n')}`,
              },
            },
          ],
          systemPrompt: 'You are analyzing search patterns to understand user intent.',
          maxTokens: 100,
        },
      }

      const result = await this.server['createMessage'](samplingRequest.params)
      const content = this.extractTextContent(result.message.content)
      session.searchIntent = content
      return content
    } catch (error) {
      console.error('Intent analysis failed:', error)
      return undefined
    }
  }

  /**
   * Extracts text content from various message formats
   */
  private extractTextContent(content: any): string {
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('')
    }
    if (content.type === 'text') {
      return content.text
    }
    return ''
  }

  private getRefUrl(): string {
    return process.env.REF_URL || 'https://api.ref.tools'
  }

  private getAuthHeaders(apiKey?: string): Record<string, string | undefined> {
    return {
      'X-Ref-Alpha': process.env.REF_ALPHA || apiKey,
      'X-Ref-Api-Key': process.env.REF_API_KEY || apiKey,
    }
  }

  /**
   * Clears session data
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Gets session statistics
   */
  getSessionStats(sessionId: string): any {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    return {
      searchCount: session.searchHistory.length,
      viewedUrls: session.viewedUrls.size,
      refinementCount: session.refinementCount,
      currentIntent: session.searchIntent,
      recentSearches: session.searchHistory.slice(-5),
    }
  }
}

/**
 * Enhanced search tool with MCP sampling integration
 */
export function createSamplingSearchTool(server: Server) {
  const handler = new SamplingSearchHandler(server)

  return {
    name: 'ref_search_with_sampling',
    description: 'Search documentation with intelligent result ranking using MCP sampling',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for documentation',
        },
        enableSampling: {
          type: 'boolean',
          description: 'Enable MCP sampling for intelligent ranking (default: true)',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
      },
      required: ['query'],
    },
    handler: async (params: any, sessionId?: string) => {
      const results = await handler.performSamplingSearch(
        params.query,
        sessionId
      )

      // Analyze intent after multiple searches
      if (sessionId) {
        const session = handler['sessions'].get(sessionId)
        if (session && session.searchHistory.length >= 3 && !session.searchIntent) {
          await handler.analyzeSearchIntent(sessionId)
        }
      }

      return {
        content: results.map(r => ({
          type: 'text' as const,
          text: `[${r.relevanceScore?.toFixed(2) || 'N/A'}] ${r.title}
URL: ${r.url}
${r.relevanceReason || r.overview}
${r.contextMatch ? `Matches: ${r.contextMatch.join(', ')}` : ''}`,
        })),
      }
    },
  }
}