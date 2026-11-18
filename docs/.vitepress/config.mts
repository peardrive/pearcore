import { defineConfig } from 'vitepress';

const SITE_ORIGIN = 'https://peardrive.github.io';
const BASE = '/pearcore/';
const SITE_URL = `${SITE_ORIGIN}${BASE}`;
const SITE_NAME = 'PearCore';
const SITE_DESCRIPTION =
  'PearCore is a modular peer-to-peer framework for decentralized applications with accounts, encrypted spaces, messaging, and file sharing.';

function pageUrl(relativePath: string) {
  const cleanPath = relativePath.replace(/index\.md$/, '').replace(/\.md$/, '');

  return encodeURI(`${SITE_URL}${cleanPath}`);
}

export default defineConfig({
  lang: 'en-US',
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: SITE_URL,
    lastmodDateOnly: false,
  },
  head: [
    [
      'link',
      { rel: 'icon', type: 'image/svg+xml', href: `${BASE}favicon.svg` },
    ],
    ['meta', { name: 'theme-color', content: '#0f172a' }],
    ['meta', { name: 'author', content: 'Anjou Team' }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],
  transformPageData(pageData) {
    if (pageData.relativePath === '404.md') {
      return;
    }

    const canonicalUrl = pageUrl(pageData.relativePath);
    const isHome = pageData.frontmatter.layout === 'home';
    const pageTitle = pageData.title || SITE_NAME;
    const title = isHome ? SITE_NAME : `${pageTitle} | ${SITE_NAME}`;
    const description = pageData.frontmatter.description || SITE_DESCRIPTION;

    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: canonicalUrl }],
      [
        'meta',
        { property: 'og:type', content: isHome ? 'website' : 'article' },
      ],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: canonicalUrl }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
    );

    const structuredData = isHome
      ? {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: SITE_NAME,
          url: SITE_URL,
          description,
        }
      : {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: pageTitle,
          description,
          url: canonicalUrl,
          isPartOf: {
            '@type': 'WebSite',
            name: SITE_NAME,
            url: SITE_URL,
          },
        };

    pageData.frontmatter.head.push([
      'script',
      { type: 'application/ld+json' },
      JSON.stringify(structuredData),
    ]);
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: SITE_NAME,
    nav: [
      {
        text: 'Guide',
        link: '/examples',
        activeMatch:
          '^/(examples|accounts|spaces|profiles|messages|files|networking)',
      },
      { text: 'Reference', link: '/core-services' },
      {
        text: 'GitHub',
        link: 'https://github.com/peardrive/pearcore',
      },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Quick Start', link: '/examples' },
        ],
      },
      {
        text: 'Core Concepts',
        items: [
          { text: 'Accounts', link: '/accounts' },
          { text: 'Spaces', link: '/spaces' },
          { text: 'Profiles', link: '/profiles' },
          { text: 'Messaging', link: '/messages' },
          { text: 'File Sharing', link: '/files' },
          { text: 'Networking', link: '/networking' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'Core Services', link: '/core-services' }],
      },
    ],
    search: {
      provider: 'local',
    },
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/peardrive/pearcore',
      },
    ],
    editLink: {
      pattern: 'https://github.com/peardrive/pearcore/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    lastUpdated: {
      text: 'Updated',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright (c) 2026 PearCore',
    },
  },
});
