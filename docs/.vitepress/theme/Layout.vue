<script setup lang="ts">
import { withBase } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import bannerUrl from '../../assets/pearcore-header-dark.png';

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <section class="pc-home-banner">
        <h1 class="pc-visually-hidden">PearCore documentation</h1>
        <img
          class="pc-home-banner__image"
          :src="bannerUrl"
          alt="PearCore — the peer-to-peer networking engine behind Peardrive"
        />
        <div class="pc-home-banner__actions">
          <a
            class="pc-home-banner__button pc-home-banner__button--brand"
            :href="withBase('/examples')"
          >
            Get Started
          </a>
          <a
            class="pc-home-banner__button"
            href="https://github.com/peardrive/pearcore"
            target="_blank"
            rel="noreferrer"
          >
            View on GitHub
          </a>
        </div>
      </section>
    </template>
  </Layout>
</template>
