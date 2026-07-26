#pragma once
namespace tbb { class task_arena { public: task_arena(int=0){} template<class F> auto execute(F&& f)->decltype(f()){ return f(); } }; namespace this_task_arena { inline int max_concurrency(){return 1;} } }
