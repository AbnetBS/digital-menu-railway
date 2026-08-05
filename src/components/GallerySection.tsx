"use client";

import { useState } from "react";
import { Camera, Eye, X, Image as ImageIcon } from "lucide-react";
import { GalleryItem } from "@/types";

interface GalleryProps {
  items: GalleryItem[];
}

export default function GallerySection({ items }: GalleryProps) {
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [lightboxItem, setLightboxItem] = useState<GalleryItem | null>(null);

  const categories = ["All", "Coffee", "Juices", "Meals", "Desserts", "Interior", "Outdoor"];

  const filteredItems = items.filter(
    (item) => selectedCategory === "All" || item.category.toLowerCase() === selectedCategory.toLowerCase()
  );

  return (
    <section id="gallery" className="py-20 bg-[#2C1B17] text-white relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#C9A227]/20 border border-[#C9A227]/40 text-[#C9A227] text-xs font-bold uppercase tracking-widest mb-3">
            <Camera className="w-3.5 h-3.5" />
            <span>Visual Tour</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-serif font-bold text-amber-100">
            Moments at Fana Cafe
          </h2>

          <p className="text-stone-300 text-sm sm:text-base mt-3 font-light">
            Explore our rich coffee art, fresh juices, comfortable dining spaces, and pleasant indoor & outdoor seating options.
          </p>
        </div>

        {/* Category Pills */}
        <div className="flex items-center justify-center gap-2 overflow-x-auto pb-4 mb-10 scrollbar-none">
          {categories.map((cat) => {
            const isActive = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-4 py-2 rounded-full text-xs font-bold transition-all whitespace-nowrap ${
                  isActive
                    ? "bg-[#C9A227] text-[#2C1B17] shadow-lg scale-105"
                    : "bg-white/10 text-stone-300 hover:bg-white/20"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        {/* Gallery Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredItems.map((item) => (
            <div
              key={item.id}
              onClick={() => setLightboxItem(item)}
              className="group relative h-72 rounded-3xl overflow-hidden border border-[#C9A227]/20 shadow-xl cursor-pointer"
            >
              <img
                src={item.imageUrl}
                alt={item.title}
                className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-60 group-hover:opacity-80 transition-opacity" />

              <div className="absolute inset-0 p-6 flex flex-col justify-end text-white">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-[#C9A227] bg-black/50 px-2.5 py-1 rounded-full w-fit mb-2">
                  {item.category}
                </span>
                <h3 className="text-lg font-serif font-bold group-hover:text-[#C9A227] transition-colors">
                  {item.title}
                </h3>
                {item.caption && (
                  <p className="text-xs text-stone-300 font-light mt-1 line-clamp-2">
                    {item.caption}
                  </p>
                )}
              </div>

              <div className="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm text-amber-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Eye className="w-5 h-5" />
              </div>
            </div>
          ))}
        </div>

      </div>

      {/* Lightbox Modal */}
      {lightboxItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-lg animate-fadeIn">
          <div className="relative max-w-4xl w-full bg-[#2C1B17] rounded-3xl overflow-hidden border border-[#C9A227] shadow-2xl">
            <button
              onClick={() => setLightboxItem(null)}
              className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black"
            >
              <X className="w-6 h-6" />
            </button>

            <div className="max-h-[70vh] overflow-hidden flex items-center justify-center bg-black">
              <img
                src={lightboxItem.imageUrl}
                alt={lightboxItem.title}
                className="w-full h-full object-contain"
              />
            </div>

            <div className="p-6 bg-[#3D2314] text-white">
              <span className="text-xs font-bold text-[#C9A227] uppercase tracking-wider">
                {lightboxItem.category}
              </span>
              <h3 className="text-2xl font-serif font-bold mt-1">{lightboxItem.title}</h3>
              {lightboxItem.caption && (
                <p className="text-stone-300 text-sm mt-2">{lightboxItem.caption}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
