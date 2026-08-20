"use client";

import { useState, useMemo } from "react";
import {
  Search, Plus, Minus, Coffee, GlassWater, CookingPot, Sandwich, Cake, Utensils, UtensilsCrossed,
  Soup, Beef, Pizza, Salad, ChefHat, Package, CupSoda, Clock, Info,
} from "lucide-react";
import { MenuItem, Category } from "@/types";
import { useT } from "@/lib/i18n";

interface MenuSectionProps {
  items: MenuItem[];
  categories: Category[];
  onAddToCart?: (item: MenuItem, qty: number) => void;
  cartMap?: Record<number, number>;
  /** When true, customers can only browse — no ordering buttons (QR menu mode). */
  browseOnly?: boolean;
}

export default function MenuSection({ items, categories, onAddToCart, cartMap = {}, browseOnly = false }: MenuSectionProps) {
  const t = useT();
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeItemModal, setActiveItemModal] = useState<MenuItem | null>(null);

  // Category Icon Resolver
  const renderCategoryIcon = (iconName: string) => {
    switch (iconName.toLowerCase()) {
      case "coffee":
        return <Coffee className="w-4 h-4" />;
      case "cupsoda":
        return <CupSoda className="w-4 h-4" />;
      case "glasswater":
      case "juices":
        return <GlassWater className="w-4 h-4" />;
      case "cookingpot":
        return <CookingPot className="w-4 h-4" />;
      case "sandwich":
        return <Sandwich className="w-4 h-4" />;
      case "cake":
        return <Cake className="w-4 h-4" />;
      case "soup":
        return <Soup className="w-4 h-4" />;
      case "beef":
        return <Beef className="w-4 h-4" />;
      case "pizza":
        return <Pizza className="w-4 h-4" />;
      case "salad":
        return <Salad className="w-4 h-4" />;
      case "chefhat":
        return <ChefHat className="w-4 h-4" />;
      case "package":
        return <Package className="w-4 h-4" />;
      case "utensilscrossed":
        return <UtensilsCrossed className="w-4 h-4" />;
      default:
        return <Utensils className="w-4 h-4" />;
    }
  };

  // Filtered Items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesCategory =
        selectedCategory === "all" ||
        item.category.toLowerCase() === selectedCategory.toLowerCase();

      const matchesSearch =
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.dietaryTags && item.dietaryTags.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [items, selectedCategory, searchQuery]);

  return (
    <section id="menu" className="py-20 bg-[#FAF6F0] relative min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header Title */}
        <div className="text-center max-w-3xl mx-auto mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#4E342E]/10 border border-[#4E342E]/20 text-[#4E342E] text-xs font-bold uppercase tracking-widest mb-3">
            <Utensils className="w-3.5 h-3.5 text-[#C9A227]" />
            <span>Our Full Menu</span>
          </div>

          <h2 className="text-3xl sm:text-5xl font-serif font-bold text-[#2C1B17]">
            {t("sec_menu")}
          </h2>

          <p className="text-stone-600 text-sm sm:text-base mt-3">
            Browse our complete selection of coffee, fresh fruit juices, Ethiopian favorites, club sandwiches, pastries, and snacks. All prices listed in Ethiopian Birr (ETB).
          </p>
        </div>

        {/* Controls: Search Bar & Category Filter Pills */}
        <div className="space-y-6 mb-12 max-w-4xl mx-auto">
          
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search coffee, Spris juice, club sandwich, or desserts..."
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-white border border-[#C9A227]/30 shadow-md focus:outline-none focus:ring-2 focus:ring-[#C9A227] text-sm text-[#2C1B17] placeholder-stone-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-stone-400 hover:text-stone-700 bg-stone-100 px-2 py-1 rounded-full"
              >
                Clear
              </button>
            )}
          </div>

          {/* Category Pills Slider */}
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
            {categories.map((cat) => {
              const isActive = selectedCategory === cat.slug;
              return (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.slug)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-xs font-bold tracking-wide transition-all whitespace-nowrap shrink-0 shadow-sm ${
                    isActive
                      ? "bg-[#4E342E] text-amber-200 border border-[#C9A227] scale-105 shadow-md"
                      : "bg-white text-stone-700 hover:bg-[#FAF6F0] border border-stone-200"
                  }`}
                >
                  <span className={isActive ? "text-[#C9A227]" : "text-stone-500"}>
                    {renderCategoryIcon(cat.icon)}
                  </span>
                  <span>{cat.name}</span>
                </button>
              );
            })}
          </div>

        </div>

        {/* Results Counter */}
        <div className="flex items-center justify-between mb-6 text-xs text-stone-500 border-b border-stone-200 pb-3">
          <span>
            Showing <strong className="text-[#2C1B17]">{filteredItems.length}</strong> items
          </span>
          {selectedCategory !== "all" && (
            <button
              onClick={() => setSelectedCategory("all")}
              className="text-[#C9A227] hover:underline font-semibold"
            >
              Reset Category Filter
            </button>
          )}
        </div>

        {/* Menu Items Grid */}
        {filteredItems.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-3xl border border-dashed border-stone-300">
            <Utensils className="w-12 h-12 text-stone-300 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-[#2C1B17]">No menu items match your search</h3>
            <p className="text-xs text-stone-500 mt-1">Try clearing your search term or selecting another category.</p>
            <button
              onClick={() => {
                setSearchQuery("");
                setSelectedCategory("all");
              }}
              className="mt-4 px-4 py-2 bg-[#4E342E] text-amber-200 text-xs font-bold rounded-full hover:bg-[#3D2314]"
            >
              Show All Menu Items
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredItems.map((item) => {
              const qtyInCart = cartMap[item.id] || 0;

              return (
                <div
                  key={item.id}
                  className="bg-white rounded-3xl border border-[#C9A227]/20 shadow-lg hover:shadow-2xl transition-all duration-300 flex flex-col overflow-hidden group hover:-translate-y-1"
                >
                  {/* Image Header with Badge */}
                  <div className="relative h-52 overflow-hidden bg-stone-100 cursor-pointer" onClick={() => setActiveItemModal(item)}>
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-60" />

                    {item.badge && (
                      <span className="absolute top-3 left-3 bg-[#C9A227] text-[#2C1B17] text-[10px] font-extrabold uppercase tracking-widest px-3 py-1 rounded-full shadow-md">
                        {item.badge}
                      </span>
                    )}

                    {item.prepTime && (
                      <span className="absolute top-3 right-3 bg-black/60 backdrop-blur-md text-stone-200 text-[10px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1">
                        <Clock className="w-3 h-3 text-[#C9A227]" />
                        {item.prepTime}
                      </span>
                    )}

                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-white">
                      <span className="text-xs font-semibold bg-black/40 px-2.5 py-0.5 rounded-md backdrop-blur-sm">
                        {item.category.replace("-", " ").toUpperCase()}
                      </span>
                      {!item.isAvailable && (
                        <span className="text-xs bg-rose-600 text-white font-bold px-2 py-0.5 rounded">
                          Sold Out
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Body Info */}
                  <div className="p-5 flex-1 flex flex-col justify-between space-y-4">
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h3
                          onClick={() => setActiveItemModal(item)}
                          className="text-lg font-serif font-bold text-[#2C1B17] hover:text-[#C9A227] cursor-pointer transition-colors"
                        >
                          {item.name}
                        </h3>
                        <span className="text-lg font-serif font-black text-[#4E342E] whitespace-nowrap bg-amber-100/60 px-2.5 py-0.5 rounded-lg border border-amber-300/40">
                          {item.price} ETB
                        </span>
                      </div>

                      <p className="text-stone-600 text-xs mt-2 line-clamp-2 leading-relaxed font-light">
                        {item.description}
                      </p>

                      {/* Dietary tags */}
                      {item.dietaryTags && (
                        <div className="flex flex-wrap gap-1.5 mt-3">
                          {item.dietaryTags.split(",").map((tag, tIdx) => (
                            <span
                              key={tIdx}
                              className="text-[10px] font-medium text-stone-600 bg-stone-100 px-2 py-0.5 rounded-md border border-stone-200"
                            >
                              {tag.trim()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Bottom Action bar */}
                    <div className="pt-3 border-t border-stone-100 flex items-center justify-between gap-2">
                      <button
                        onClick={() => setActiveItemModal(item)}
                        className="text-xs text-stone-500 hover:text-[#4E342E] flex items-center gap-1 font-semibold"
                      >
                        <Info className="w-3.5 h-3.5" />
                        <span>Details</span>
                      </button>

                      {browseOnly ? (
                        !item.isAvailable && (
                          <span className="bg-stone-200 text-stone-500 font-bold text-xs px-3 py-1.5 rounded-full">
                            Unavailable
                          </span>
                        )
                      ) : item.isAvailable ? (
                        qtyInCart > 0 ? (
                          <div className="flex items-center gap-2 bg-[#4E342E] text-white rounded-full p-1 shadow-md">
                            <button
                              onClick={() => onAddToCart?.(item, qtyInCart - 1)}
                              className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-amber-200"
                              title="Decrease"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <span className="text-xs font-bold px-1 text-amber-300">{qtyInCart}</span>
                            <button
                              onClick={() => onAddToCart?.(item, qtyInCart + 1)}
                              className="w-7 h-7 rounded-full bg-[#C9A227] text-[#2C1B17] hover:bg-amber-400 flex items-center justify-center font-bold"
                              title="Increase"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => onAddToCart?.(item, 1)}
                            className="inline-flex items-center gap-1.5 bg-[#4E342E] hover:bg-[#3D2314] text-amber-200 font-bold text-xs px-4 py-2 rounded-full shadow transition hover:scale-105"
                          >
                            <Plus className="w-3.5 h-3.5 text-[#C9A227]" />
                            <span>Add to Order</span>
                          </button>
                        )
                      ) : (
                        <button
                          disabled
                          className="bg-stone-200 text-stone-400 font-bold text-xs px-3 py-1.5 rounded-full cursor-not-allowed"
                        >
                          Unavailable
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>

      {/* Item Detail Modal */}
      {activeItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl border border-[#C9A227] relative animate-scaleUp">
            
            <button
              onClick={() => setActiveItemModal(null)}
              className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black"
            >
              ✕
            </button>

            <div className="relative h-64">
              <img
                src={activeItemModal.imageUrl}
                alt={activeItemModal.name}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
              <div className="absolute bottom-4 left-6 right-6 text-white">
                <span className="text-xs font-bold uppercase tracking-widest text-[#C9A227] bg-black/50 px-2.5 py-1 rounded">
                  {activeItemModal.category}
                </span>
                <h3 className="text-2xl font-serif font-bold mt-1 text-white">{activeItemModal.name}</h3>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-serif font-black text-[#4E342E]">
                  {activeItemModal.price} ETB
                </span>
                <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
                  Prep Time: {activeItemModal.prepTime || "10 min"}
                </span>
              </div>

              <p className="text-stone-700 text-sm leading-relaxed">{activeItemModal.description}</p>

              {activeItemModal.dietaryTags && (
                <div>
                  <h4 className="text-xs font-bold uppercase text-stone-400 tracking-wider mb-2">
                    Dietary & Features
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {activeItemModal.dietaryTags.split(",").map((tag, i) => (
                      <span
                        key={i}
                        className="text-xs font-semibold text-[#2C1B17] bg-amber-100 px-3 py-1 rounded-full border border-amber-300/50"
                      >
                        ✓ {tag.trim()}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-stone-200 flex items-center justify-between">
                <span className="text-xs text-stone-500">{browseOnly ? "Call your waiter to order this item" : "Includes warm Ethiopian hospitality"}</span>
                {!browseOnly && (
                  <button
                    onClick={() => {
                      const currentQty = cartMap[activeItemModal.id] || 0;
                      onAddToCart?.(activeItemModal, currentQty + 1);
                      setActiveItemModal(null);
                    }}
                    className="bg-gradient-to-r from-[#C9A227] to-[#B8921F] text-[#2C1B17] font-bold text-sm px-6 py-2.5 rounded-full shadow-lg hover:scale-105 transition"
                  >
                    Add To Order ({activeItemModal.price} ETB)
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

    </section>
  );
}
