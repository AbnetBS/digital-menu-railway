"use client";

import { useState, useEffect } from "react";
import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import AboutSection from "@/components/AboutSection";
import WhyChooseSection from "@/components/WhyChooseSection";
import MenuSection from "@/components/MenuSection";
import ServicesSection from "@/components/ServicesSection";
import GallerySection from "@/components/GallerySection";
import ReviewsSection from "@/components/ReviewsSection";
import LocationSection from "@/components/LocationSection";
import FaqSection from "@/components/FaqSection";
import CtaBanner from "@/components/CtaBanner";
import LanguageToggle from "@/components/LanguageToggle";
import Footer from "@/components/Footer";

import { MenuItem, Category, SiteSettings, Review, GalleryItem } from "@/types";
import { DEFAULT_SETTINGS, DEFAULT_CATEGORIES, DEFAULT_MENU_ITEMS, DEFAULT_REVIEWS, DEFAULT_GALLERY } from "@/lib/initial-data";

export default function HomePage() {
  const [settings, setSettings] = useState<SiteSettings>(DEFAULT_SETTINGS as SiteSettings);
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [isAdminLoggedIn, setIsAdminLoggedIn] = useState(false);

  const loadSiteData = async () => {
    try {
      // PERFORMANCE: no /api/seed call — data routes self-initialize on first read
      // (seed runs once per server process). All data fetches run in parallel.
      const [settingsRes, catRes, menuRes, revRes, galRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/categories"),
        fetch("/api/menu"),
        fetch("/api/reviews"),
        fetch("/api/gallery"),
      ]);

      if (settingsRes.ok) {
        const sData = await settingsRes.json();
        if (Object.keys(sData).length > 0) setSettings(sData);
      }

      if (catRes.ok) {
        const cData = await catRes.json();
        if (cData.length > 0) setCategories(cData);
      }

      if (menuRes.ok) {
        const mData = await menuRes.json();
        if (mData.length > 0) setMenuItems(mData);
      }

      if (revRes.ok) {
        const rData: Review[] = await revRes.json();
        // only approved reviews are publicly visible
        const approved = rData.filter((r) => r.isApproved);
        if (approved.length > 0) setReviews(approved);
      }

      if (galRes.ok) {
        const gData = await galRes.json();
        if (gData.length > 0) setGallery(gData);
      }
    } catch (err) {
      console.error("Error loading Fana Cafe data:", err);
    }
  };

  useEffect(() => {
    loadSiteData();
    fetch("/api/admin/verify")
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) setIsAdminLoggedIn(true);
      })
      .catch(() => {});
  }, []);

  const goToAdmin = () => {
    window.location.href = "/admin";
  };

  const scrollToMenu = () => {
    const el = document.getElementById("menu");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  const scrollToLocation = () => {
    const el = document.getElementById("contact");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-[#FAF6F0] text-[#2C1B17] font-sans selection:bg-[#C9A227] selection:text-[#2C1B17]">
      <Navbar settings={settings} onOpenAdmin={goToAdmin} isAdminLoggedIn={isAdminLoggedIn} />
      <LanguageToggle />

      <main>
        <HeroSection settings={settings} onOpenMenu={scrollToMenu} onOpenLocation={scrollToLocation} />

        {/* Menu comes FIRST — clean & simple, what visitors want to see immediately */}
        <MenuSection items={menuItems} categories={categories} browseOnly />

        <AboutSection settings={settings} />

        <WhyChooseSection />

        <ServicesSection />

        <GallerySection items={gallery} />

        <LocationSection settings={settings} />

        <FaqSection />

        <ReviewsSection reviews={reviews} onReviewSubmitted={loadSiteData} />

        <CtaBanner settings={settings} onOpenMenu={scrollToMenu} />
      </main>

      <Footer settings={settings} onOpenAdmin={goToAdmin} isAdminLoggedIn={isAdminLoggedIn} />
    </div>
  );
}
